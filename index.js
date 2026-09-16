// engine.js - Dynamic First-Principles ICME Weld Predictor Engine (ES6)

export class MaterialDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaterialDataError";
  }
}

export class ProcessParameterError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessParameterError";
  }
}

export class DynamicICMEWeldPredictor {
  static REQUIRED_KEYS = [
    'name', 'crystal_structure', 'density', 'k', 'cp', 'Tm',
    'latent_heat_fusion', 'E', 'H0', 'k_hp', 'comp'
  ];

  static REQUIRED_COMP_KEYS = [
    'C', 'Mn', 'Si', 'Cr', 'Ni', 'Mo', 'V', 'Cu', 'N', 'B', 'Ti', 'Al', 'S', 'P'
  ];

  static _POSITIVE_KEYS = ['density', 'k', 'cp', 'Tm', 'latent_heat_fusion', 'E', 'k_hp'];

  static _DENSITY_BAND_STEEL = [7200.0, 8300.0];
  static _DENSITY_BAND_TITANIUM = [4200.0, 4900.0];
  static _DENSITY_BAND_ALUMINUM = [2500.0, 3050.0];

  static _NICKEL_SUPERALLOY_NI_THRESHOLD = 30.0;

  constructor(materialData) {
    if (typeof materialData !== 'object' || materialData === null || Array.isArray(materialData)) {
      throw new TypeError("materialData must be a dictionary or parsed JSON object.");
    }
    this.mat = materialData;
    this._validateMaterialData();
  }

  static async fromJson(jsonPath, alloyKey) {
    const response = await fetch(jsonPath);
    if (!response.ok) {
      throw new Error(`Failed to load alloy database from ${jsonPath}: ${response.statusText}`);
    }
    const database = await response.json();
    if (!(alloyKey in database)) {
      throw new KeyError(`Alloy key '${alloyKey}' not found in database ${jsonPath}. Available: ${Object.keys(database).join(', ')}`);
    }
    return new DynamicICMEWeldPredictor(database[alloyKey]);
  }

  _validateMaterialData() {
    for (const key of DynamicICMEWeldPredictor.REQUIRED_KEYS) {
      if (!(key in this.mat)) {
        throw new MaterialDataError(`Missing required material property key: '${key}'`);
      }
    }

    for (const key of DynamicICMEWeldPredictor._POSITIVE_KEYS) {
      const val = Number(this.mat[key]);
      if (isNaN(val)) throw new MaterialDataError(`Material property '${key}' must be numeric, got ${this.mat[key]}`);
      if (val <= 0) throw new MaterialDataError(`Material property '${key}' must be > 0, got ${val}`);
    }

    if (Number(this.mat.H0) < 0) {
      throw new MaterialDataError("Material property 'H0' (baseline hardness) cannot be negative.");
    }

    if (typeof this.mat.comp !== 'object' || this.mat.comp === null || Array.isArray(this.mat.comp)) {
      throw new MaterialDataError("'comp' must be an object of elemental weight percentages.");
    }

    const comp = this.mat.comp;
    for (const elem of DynamicICMEWeldPredictor.REQUIRED_COMP_KEYS) {
      if (!(elem in comp)) {
        comp[elem] = 0.0;
      } else {
        const val = Number(comp[elem]);
        if (isNaN(val)) throw new MaterialDataError(`Composition element '${elem}' must be numeric`);
        if (val < 0) throw new MaterialDataError(`Composition element '${elem}' cannot be negative, got ${val}`);
      }
    }

    if (typeof this.mat.name !== 'string' || !this.mat.name.trim()) {
      throw new MaterialDataError("Material 'name' must be a non-empty string.");
    }

    if (typeof this.mat.crystal_structure !== 'string' || !this.mat.crystal_structure.trim()) {
      throw new MaterialDataError("Material 'crystal_structure' must be a non-empty string.");
    }
  }

  static _validateProcessParams(I, V, v_m_s, wfs_m_s, d_wire, d_plate, T0_K, Tm_K, eta) {
    if (I <= 0) throw new ProcessParameterError(`current_A must be > 0, got ${I}`);
    if (V <= 0) throw new ProcessParameterError(`voltage_V must be > 0, got ${V}`);
    if (v_m_s <= 0) throw new ProcessParameterError("travel_speed_mm_s must be > 0.");
    if (wfs_m_s < 0) throw new ProcessParameterError("wire_feed_mm_s cannot be negative.");
    if (wfs_m_s > 0 && d_wire <= 0) throw new ProcessParameterError("wire_diameter_mm must be > 0 when wire_feed_mm_s > 0.");
    if (d_plate <= 0) throw new ProcessParameterError("plate_thickness_mm must be > 0.");
    if (eta <= 0.0 || eta > 1.0) throw new ProcessParameterError(`efficiency must be in (0, 1], got ${eta}`);
    if (T0_K < 0) throw new ProcessParameterError("preheat_temp_C is below absolute zero.");
    if (T0_K >= Tm_K) {
      throw new ProcessParameterError(`preheat_temp_C (${T0_K - 273.15} C) must be below melting point (${Tm_K - 273.15} C).`);
    }
  }

  _classifyAlloy(rho, crystal, C, Cr, Ni, Al) {
    const override = this.mat.alloy_class;
    const validClasses = ['austenitic_stainless', 'carbon_steel', 'titanium', 'aluminum', 'nickel_superalloy', 'other'];
    if (override && validClasses.includes(override)) return override;

    const inSteel = rho >= DynamicICMEWeldPredictor._DENSITY_BAND_STEEL[0] && rho <= DynamicICMEWeldPredictor._DENSITY_BAND_STEEL[1];
    const inTi = rho >= DynamicICMEWeldPredictor._DENSITY_BAND_TITANIUM[0] && rho <= DynamicICMEWeldPredictor._DENSITY_BAND_TITANIUM[1];
    const inAl = rho >= DynamicICMEWeldPredictor._DENSITY_BAND_ALUMINUM[0] && rho <= DynamicICMEWeldPredictor._DENSITY_BAND_ALUMINUM[1];

    if (Ni > DynamicICMEWeldPredictor._NICKEL_SUPERALLOY_NI_THRESHOLD) return 'nickel_superalloy';
    if (Cr > 12.0 && Ni > 4.0 && inSteel) return 'austenitic_stainless';
    if (C > 0.01 && (crystal === 'BCC' || crystal === 'BCT') && inSteel) return 'carbon_steel';
    if (crystal === 'HCP' && inTi) return 'titanium';
    if (inAl && (Al > 80.0 || crystal === 'FCC' || crystal === 'HCP')) return 'aluminum';
    return 'other';
  }

  _computeGeometry(I, V, v, wfs, d_wire, d, rho, k, cp, Tm, L_f, T0, eta) {
    const power_gross = I * V;
    const power_net = eta * power_gross;
    const linear_energy_J_m = power_net / v;
    const linear_energy_kJ_mm = linear_energy_J_m / 1.0e6;

    const wire_radius = d_wire / 2.0;
    const A_wire = Math.PI * (wire_radius ** 2);
    const vol_dep_rate = A_wire * wfs;
    const mass_dep_rate_kg_h = vol_dep_rate * rho * 3600.0;
    const A_dep = vol_dep_rate / v;

    const delta_H_m = rho * (cp * (Tm - T0) + L_f);

    const denom_melt = Math.max(1e-12, k * Math.sqrt(v * d));
    let eta_melting = 0.38 * (1.0 - Math.exp(-0.06 * power_net / denom_melt));
    eta_melting = Math.max(0.15, Math.min(0.55, eta_melting));

    const A_melt_base = (eta_melting * power_net) / (delta_H_m * v);
    const A_total = A_dep + A_melt_base;
    const dilution = A_melt_base / Math.max(1e-12, A_total);

    const w_b_m = Math.sqrt((6.0 * A_total) / (Math.PI * 0.35));
    const bead_width_mm = w_b_m * 1000.0;
    const reinforcement_height_mm = (1.5 * A_dep / Math.max(1e-6, w_b_m)) * 1000.0;
    const penetration_depth_mm = (1.5 * A_melt_base / Math.max(1e-6, w_b_m)) * 1000.0;

    return {
      power_gross_W: power_gross,
      power_net_W: power_net,
      linear_energy_J_m: linear_energy_J_m,
      linear_energy_kJ_mm: linear_energy_kJ_mm,
      mass_dep_rate_kg_h: mass_dep_rate_kg_h,
      dilution: dilution,
      A_dep: A_dep,
      A_melt_base: A_melt_base,
      A_total: A_total,
      delta_H_m: delta_H_m,
      bead_width_mm: bead_width_mm,
      reinforcement_height_mm: reinforcement_height_mm,
      penetration_depth_mm: penetration_depth_mm
    };
  }

  _computeThermal(geom, v, d, rho, k, cp, T0, Tm) {
    const linear_energy_J_m = geom.linear_energy_J_m;
    const tau = d * Math.sqrt((rho * cp * Math.max(50.0, Tm - T0)) / Math.max(1.0, linear_energy_J_m));

    const denom_3d_1 = Math.max(1.0, 773.15 - T0);
    const denom_3d_2 = Math.max(1.0, 1073.15 - T0);
    const t_8_5_3D = (linear_energy_J_m / (2.0 * Math.PI * k)) * ((1.0 / denom_3d_1) - (1.0 / denom_3d_2));

    const denom_2d_1 = Math.max(1.0, (773.15 - T0) ** 2);
    const denom_2d_2 = Math.max(1.0, (1073.15 - T0) ** 2);
    const t_8_5_2D = (((linear_energy_J_m / Math.max(0.0005, d)) ** 2) / (4.0 * Math.PI * k * rho * cp)) *
                     ((1.0 / denom_2d_1) - (1.0 / denom_2d_2));

    let t_8_5_raw = tau >= 0.9 ? t_8_5_3D : t_8_5_2D;
    const thermal_regime = tau >= 0.9 ? "3D (Thick Plate Hemispherical Conduction)" : "2D (Thin Sheet In-Plane Conduction)";

    if (t_8_5_raw <= 0.0) {
      throw new ProcessParameterError(
        `Computed t_8/5 cooling time is non-positive (${t_8_5_raw.toFixed(4)} s). ` +
        `Preheat (${T0 - 273.15} C) is too close to the 800-500 C window.`
      );
    }

    const t_8_5 = Math.min(300.0, t_8_5_raw);
    const cooling_rate_K_s = 300.0 / t_8_5;
    const R_sol = v * 0.85;
    const G_grad = cooling_rate_K_s / Math.max(1e-6, R_sol);

    return {
      tau: tau,
      thermal_regime: thermal_regime,
      t_8_5_s: t_8_5,
      cooling_rate_K_s: cooling_rate_K_s,
      R_sol_m_s: R_sol,
      G_grad_K_m: G_grad
    };
  }

  static _computeEquivalents(comp) {
    const C = comp.C || 0.0, Mn = comp.Mn || 0.0, Si = comp.Si || 0.0, Cr = comp.Cr || 0.0;
    const Ni = comp.Ni || 0.0, Mo = comp.Mo || 0.0, V_el = comp.V || 0.0, Cu = comp.Cu || 0.0;
    const N = comp.N || 0.0, B = comp.B || 0.0, Ti = comp.Ti || 0.0;

    const CE_IIW = C + (Mn / 6.0) + ((Cr + Mo + V_el) / 5.0) + ((Ni + Cu) / 15.0);
    const P_cm = C + (Si / 30.0) + ((Mn + Cu + Cr) / 20.0) + (Ni / 60.0) + (Mo / 15.0) + (V_el / 10.0) + (5.0 * B);
    const Cr_eq = Cr + Mo + (1.5 * Si) + (0.5 * Ti);
    const Ni_eq = Ni + (35.0 * C) + (20.0 * N) + (0.25 * Mn);
    const M_s_degC = 539.0 - (423.0 * C) - (30.4 * Mn) - (12.1 * Cr) - (17.7 * Ni) - (7.5 * Mo);

    return {
      C, Mn, Si, Cr, Ni, Mo, V: V_el, Cu, N, B, Ti,
      Al: comp.Al || 0.0, S: comp.S || 0.0, P: comp.P || 0.0,
      CE_IIW, P_cm, Cr_eq, Ni_eq, M_s_degC
    };
  }

  static _computePhases(alloy_class, eq, cooling_rate_K_s) {
    const Cr_eq = eq.Cr_eq, Ni_eq = eq.Ni_eq;
    const CE_IIW = eq.CE_IIW, M_s_degC = eq.M_s_degC;

    if (alloy_class === 'austenitic_stainless') {
      const FN = Math.max(0.0, 3.0 * (Cr_eq - 1.37 * Ni_eq - 1.5) + 2.0);
      const vol_delta_ferrite = Math.min(100.0, Math.max(0.0, 0.9 * FN));
      const vol_austenite = 100.0 - vol_delta_ferrite;
      return [
        {
          'Austenite (γ)': Number(vol_austenite.toFixed(2)),
          'δ-Ferrite': Number(vol_delta_ferrite.toFixed(2)),
          'Martensite': 0.0, 'Bainite': 0.0, 'Ferrite/Pearlite': 0.0
        },
        FN
      ];
    }

    if (alloy_class === 'carbon_steel') {
      const V_c = 10.0 ** (4.3 - 2.8 * CE_IIW);
      let vol_m = 0.0, vol_b = 0.0, vol_fp = 0.0;
      if (cooling_rate_K_s >= V_c) {
        vol_m = 100.0 * (1.0 - Math.exp(-0.011 * Math.max(0.0, M_s_degC - 25.0)));
        vol_b = 100.0 - vol_m;
        vol_fp = 0.0;
      } else {
        vol_m = Math.min(100.0, Math.max(0.0, 100.0 * ((cooling_rate_K_s / Math.max(0.1, V_c)) ** 1.5)));
        vol_b = Math.min(100.0 - vol_m, Math.max(0.0, (100.0 - vol_m) * 0.45 * CE_IIW));
        vol_fp = Math.max(0.0, 100.0 - vol_m - vol_b);
      }
      return [
        {
          'Martensite': Number(vol_m.toFixed(2)),
          'Bainite': Number(vol_b.toFixed(2)),
          'Ferrite/Pearlite': Number(vol_fp.toFixed(2)),
          'Austenite (γ)': 0.0, 'δ-Ferrite': 0.0
        },
        null
      ];
    }

    if (alloy_class === 'titanium') {
      return [{ 'α/α\' Martensitic Titanium': 88.0, 'Prior β Phase': 12.0 }, null];
    }

    if (alloy_class === 'aluminum') {
      return [{ 'α-Aluminum Matrix': 96.5, 'Precipitate Phases (Mg2Si/Al2Cu)': 3.5 }, null];
    }

    return [{ 'Primary Matrix Phase': 100.0 }, null];
  }

  static _computeMechanical(alloy_class, phase_dict, FN, eq, cooling_rate_K_s, H0, k_hp, grain_size_mm) {
    const HV_HP = k_hp / Math.sqrt(grain_size_mm);
    const cooling_rate_C_h = cooling_rate_K_s * 3600.0;
    const log_CR = Math.log10(Math.max(1.0, cooling_rate_C_h));

    const C = eq.C, Si = eq.Si, Mn = eq.Mn, Ni = eq.Ni, Cr = eq.Cr, Mo = eq.Mo;

    const HV_M = 127.0 + (949.0 * C) + (27.0 * Si) + (12.0 * Mn) + (8.0 * Ni) + (16.0 * Cr) + (21.0 * log_CR);
    const HV_B = 323.0 + (185.0 * C) + (330.0 * Si) + (153.0 * Mn) + (65.0 * Ni) + (144.0 * Cr) + (191.0 * Mo) + ((89.0 - 53.0 * C) * log_CR);
    const HV_FP = 42.0 + (223.0 * C) + (53.0 * Si) + (30.0 * Mn) + (12.5 * Ni) + (29.0 * Cr) + (19.0 * Mo) + ((10.0 - 19.0 * Si + 4.0 * Cr) * log_CR);

    let hardness_model = null;
    let vickers_hardness_HV = null;

    if (alloy_class === 'austenitic_stainless') {
      const v_delta = phase_dict['δ-Ferrite'] || 0.0;
      vickers_hardness_HV = H0 + (2.5 * v_delta) + HV_HP;
      hardness_model = 'austenitic_ss_FN+HallPetch';
    } else if (alloy_class === 'carbon_steel') {
      const v_m = (phase_dict['Martensite'] || 0.0) / 100.0;
      const v_b = (phase_dict['Bainite'] || 0.0) / 100.0;
      const v_fp = (phase_dict['Ferrite/Pearlite'] || 0.0) / 100.0;
      const HV_mix = (v_m * HV_M) + (v_b * HV_B) + (v_fp * HV_FP);
      vickers_hardness_HV = Math.max(H0, HV_mix + (0.15 * HV_HP));
      hardness_model = 'Maynier-Blondeau_mix+HallPetch';
    } else {
      vickers_hardness_HV = null;
      hardness_model = 'unsupported_no_calibrated_model';
    }

    let ys_slope = 2.85, ys_intercept = -35.0;
    let uts_slope = 3.20, uts_intercept = 25.0;
    let elong_a = 11500.0, elong_b = 90.0, elong_floor = 3.0, elong_cap = 40.0;

    if (alloy_class === 'carbon_steel') {
      ys_slope = 2.85; ys_intercept = -35.0;
      uts_slope = 3.20; uts_intercept = 25.0;
      elong_a = 11500.0; elong_b = 90.0; elong_floor = 3.0; elong_cap = 40.0;
    } else if (alloy_class === 'austenitic_stainless') {
      ys_slope = 3.10; ys_intercept = -40.0;
      uts_slope = 3.45; uts_intercept = 20.0;
      elong_a = 14000.0; elong_b = 120.0; elong_floor = 8.0; elong_cap = 60.0;
    }

    let yield_strength_MPa = null;
    let ultimate_tensile_strength_MPa = null;
    let elongation_pct = null;

    if (vickers_hardness_HV !== null) {
      vickers_hardness_HV = Math.max(60.0, Math.min(850.0, vickers_hardness_HV));
      yield_strength_MPa = Math.max(0.0, ys_slope * vickers_hardness_HV + ys_intercept);
      ultimate_tensile_strength_MPa = Math.max(yield_strength_MPa, uts_slope * vickers_hardness_HV + uts_intercept);
      elongation_pct = Math.max(elong_floor, Math.min(elong_cap, elong_a / (vickers_hardness_HV + elong_b) - 12.0));
    }

    return {
      hardness_model,
      vickers_hardness_HV,
      yield_strength_MPa,
      ultimate_tensile_strength_MPa,
      elongation_pct,
      HV_HP_component: HV_HP
    };
  }

  static _computeDefects(alloy_class, eq, phase_dict, FN, geom, thermal, H_D, R_F) {
    const S = eq.S, P = eq.P, Cr_eq = eq.Cr_eq, Ni_eq = eq.Ni_eq, P_cm = eq.P_cm;
    const linear_energy_kJ_mm = geom.linear_energy_kJ_mm;
    const linear_energy_J_m = geom.linear_energy_J_m;
    const A_total = geom.A_total;
    const delta_H_m = geom.delta_H_m;

    let hot_cracking_risk_pct = null;
    let cold_cracking_risk_pct = null;
    let P_w = null;
    let critical_preheat_C = null;
    const defect_notes = [];

    if (alloy_class === 'austenitic_stainless') {
      const CrNi_ratio = Cr_eq / Math.max(0.1, Ni_eq);
      const base_risk = Math.max(0.0, Math.min(100.0, (1.52 - CrNi_ratio) * 220.0));
      const fn_val = FN === null ? 0.0 : FN;
      const fn_penalty = fn_val < 3.0 ? (3.0 - fn_val) * 12.0 : (fn_val > 15.0 ? (fn_val - 15.0) * 4.0 : 0.0);
      const sp_penalty = 900.0 * S + 600.0 * P;
      hot_cracking_risk_pct = Math.max(0.0, Math.min(100.0, base_risk + fn_penalty + sp_penalty));
    } else if (alloy_class === 'carbon_steel') {
      hot_cracking_risk_pct = Math.max(0.0, Math.min(100.0, 1600.0 * (S + P) + 8.0 * linear_energy_kJ_mm));
    } else {
      defect_notes.push(`Hot-cracking criteria are not evaluated for alloy class '${alloy_class}'.`);
    }

    if (alloy_class === 'carbon_steel') {
      P_w = P_cm + (H_D / 60.0) + (R_F / 40000.0);
      critical_preheat_C = Math.max(20.0, (1440.0 * P_w) - 392.0);
      cold_cracking_risk_pct = Math.max(0.0, Math.min(100.0, (P_w - 0.22) * 280.0));
    } else {
      defect_notes.push(`Hydrogen cold-cracking (Yurioka P_w index) is not evaluated for alloy class '${alloy_class}'.`);
    }

    const defect_note = defect_notes.length > 0 ? defect_notes.join(" ") : null;
    const energy_density_ratio = (linear_energy_J_m / Math.max(1e-9, A_total)) / delta_H_m;
    const lack_of_fusion_risk_pct = Math.max(0.0, Math.min(100.0, (1.25 - energy_density_ratio) * 80.0));

    let weld_quality_index = 100.0;
    if (hot_cracking_risk_pct !== null && cold_cracking_risk_pct !== null) {
      weld_quality_index = Math.max(0.0, 100.0 - (0.35 * hot_cracking_risk_pct + 0.45 * cold_cracking_risk_pct + 0.20 * lack_of_fusion_risk_pct));
    } else if (hot_cracking_risk_pct !== null) {
      weld_quality_index = Math.max(0.0, 100.0 - (0.70 * hot_cracking_risk_pct + 0.30 * lack_of_fusion_risk_pct));
    } else {
      weld_quality_index = Math.max(0.0, 100.0 - lack_of_fusion_risk_pct);
    }

    return {
      hot_cracking_risk_pct,
      yurioka_P_w_index: P_w,
      critical_preheat_temp_C: critical_preheat_C,
      cold_cracking_risk_pct,
      lack_of_fusion_risk_pct,
      overall_weld_quality_index: weld_quality_index,
      note: defect_note
    };
  }

  predict(params) {
    const {
      current_A,
      voltage_V,
      travel_speed_mm_s,
      wire_feed_mm_s,
      wire_diameter_mm,
      plate_thickness_mm,
      preheat_temp_C = 25.0,
      efficiency = 0.75,
      diffusible_hydrogen_ml_100g = 2.0,
      joint_restraint_intensity_MPa = 500.0
    } = params;

    const I = Number(current_A);
    const V = Number(voltage_V);
    const v = Number(travel_speed_mm_s) / 1000.0;
    const wfs = Number(wire_feed_mm_s) / 1000.0;
    const d_wire = Number(wire_diameter_mm) / 1000.0;
    const d = Number(plate_thickness_mm) / 1000.0;
    const T0 = Number(preheat_temp_C) + 273.15;
    const eta = Number(efficiency);
    const H_D = Number(diffusible_hydrogen_ml_100g);
    const R_F = Number(joint_restraint_intensity_MPa);

    const rho = Number(this.mat.density);
    const k = Number(this.mat.k);
    const cp = Number(this.mat.cp);
    const Tm = Number(this.mat.Tm);
    const L_f = Number(this.mat.latent_heat_fusion);
    const H0 = Number(this.mat.H0);
    const k_hp = Number(this.mat.k_hp);
    const comp = this.mat.comp;

    DynamicICMEWeldPredictor._validateProcessParams(I, V, v, wfs, d_wire, d, T0, Tm, eta);
    if (H_D < 0) throw new ProcessParameterError("diffusible_hydrogen_ml_100g cannot be negative.");
    if (R_F < 0) throw new ProcessParameterError("joint_restraint_intensity_MPa cannot be negative.");

    const crystal = (this.mat.crystal_structure || 'BCC').toUpperCase();
    const alloy_class = this._classifyAlloy(
      rho, crystal,
      comp.C || 0.0, comp.Cr || 0.0,
      comp.Ni || 0.0, comp.Al || 0.0
    );

    const geom = this._computeGeometry(I, V, v, wfs, d_wire, d, rho, k, cp, Tm, L_f, T0, eta);
    const thermal = this._computeThermal(geom, v, d, rho, k, cp, T0, Tm);
    const cooling_rate_K_s = thermal.cooling_rate_K_s;

    const eq = DynamicICMEWeldPredictor._computeEquivalents(comp);
    const [phase_dict, FN] = DynamicICMEWeldPredictor._computePhases(alloy_class, eq, cooling_rate_K_s);

    const pdas_um = 52.0 * (Math.max(0.1, cooling_rate_K_s) ** (-0.33));
    const grain_size_um = 3.2 * pdas_um;
    const grain_size_mm = grain_size_um / 1000.0;

    const mech = DynamicICMEWeldPredictor._computeMechanical(
      alloy_class, phase_dict, FN, eq, cooling_rate_K_s,
      H0, k_hp, grain_size_mm
    );

    const defects = DynamicICMEWeldPredictor._computeDefects(
      alloy_class, eq, phase_dict, FN, geom, thermal, H_D, R_F
    );

    const _r = (x, n = 4) => (x === null || x === undefined ? null : Number(x.toFixed(n)));

    return {
      material_summary: {
        name: this.mat.name,
        crystal_structure: this.mat.crystal_structure,
        alloy_class: alloy_class,
        density_kg_m3: rho,
        melting_point_K: Tm
      },
      process_and_energy: {
        gross_power_W: _r(geom.power_gross_W, 1),
        net_power_W: _r(geom.power_net_W, 1),
        linear_energy_kJ_mm: _r(geom.linear_energy_kJ_mm, 4),
        mass_deposition_rate_kg_h: _r(geom.mass_dep_rate_kg_h, 3)
      },
      bead_and_dilution_geometry: {
        dilution_ratio: _r(geom.dilution, 4),
        dilution_pct: _r(geom.dilution * 100.0, 2),
        bead_width_mm: _r(geom.bead_width_mm, 3),
        reinforcement_height_mm: _r(geom.reinforcement_height_mm, 3),
        penetration_depth_mm: _r(geom.penetration_depth_mm, 3),
        total_fused_area_mm2: _r(geom.A_total * 1e6, 3)
      },
      thermal_and_cooling_regime: {
        christensen_tau: _r(thermal.tau, 4),
        thermal_regime: thermal.thermal_regime,
        cooling_time_t_8_5_s: _r(thermal.t_8_5_s, 3),
        cooling_rate_K_s: _r(thermal.cooling_rate_K_s, 2),
        thermal_gradient_G_K_m: _r(thermal.G_grad_K_m, 1)
      },
      microstructure_and_phases: {
        compositional_equivalents: {
          CE_IIW: _r(eq.CE_IIW, 4),
          P_cm: _r(eq.P_cm, 4),
          Cr_eq: _r(eq.Cr_eq, 3),
          Ni_eq: _r(eq.Ni_eq, 3),
          M_s_temperature_C: _r(eq.M_s_degC, 1)
        },
        phase_fractions_pct: phase_dict,
        pdas_arm_spacing_um: _r(pdas_um, 2),
        prior_grain_size_um: _r(grain_size_um, 2)
      },
      mechanical_properties: {
        hardness_model: mech.hardness_model,
        vickers_hardness_HV: _r(mech.vickers_hardness_HV, 1),
        yield_strength_MPa: _r(mech.yield_strength_MPa, 1),
        ultimate_tensile_strength_MPa: _r(mech.ultimate_tensile_strength_MPa, 1),
        elongation_pct: _r(mech.elongation_pct, 1)
      },
      defect_and_cracking_risks: {
        hot_cracking_risk_pct: _r(defects.hot_cracking_risk_pct, 2),
        yurioka_P_w_index: _r(defects.yurioka_P_w_index, 4),
        critical_preheat_temp_C: _r(defects.critical_preheat_temp_C, 1),
        cold_cracking_risk_pct: _r(defects.cold_cracking_risk_pct, 2),
        lack_of_fusion_risk_pct: _r(defects.lack_of_fusion_risk_pct, 2),
        overall_weld_quality_index: _r(defects.overall_weld_quality_index, 1),
        note: defects.note
      }
    };
  }
}
