//! Explorer 模块手风琴主题（纯逻辑，复刻前端 `portal-module-theme-core.js`）。
//!
//! 用于 DAM 派生菜单时给每个模块组生成稳定的配色 `theme.{light,dark}`。

use serde_json::{Value, json};

/// SAP / Fiori 友好预设：亮色 accent + 暗色更亮 accent。
const MODULE_PALETTE: &[(&str, &str)] = &[
    ("#0070f2", "#5cadff"),
    ("#107e3e", "#7ec76e"),
    ("#e9730c", "#ffb84d"),
    ("#7c3aed", "#b794f6"),
    ("#0b7285", "#3bc9db"),
    ("#c92a2a", "#ff8787"),
    ("#364fc7", "#748ffc"),
    ("#d6336c", "#faa2c1"),
];

/// FNV-1a 32-bit hash（与前端 `hashString` 完全一致，`Math.imul` → `wrapping_mul`）。
fn hash_string(value: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in value.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

/// 校验并返回合法 CSS 颜色，否则空串（与前端 `cleanThemeColor` 等价的子集）。
fn clean_theme_color(value: &str) -> String {
    let s = value.trim();
    if s.is_empty() {
        return String::new();
    }
    let lower = s.to_lowercase();
    let ok = (lower.starts_with('#')
        && s.len() >= 4
        && s.len() <= 9
        && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        || lower.starts_with("rgb(")
        || lower.starts_with("rgba(")
        || lower.starts_with("hsl(")
        || lower.starts_with("hsla(")
        || lower.starts_with("color-mix(in srgb,");
    if ok { s.to_string() } else { String::new() }
}

/// 生成亮色主题侧配置（accent 驱动 headerBg/border 等）。
fn light_side(accent: &str) -> Value {
    json!({
        "accent": accent,
        "headerBg": format!("color-mix(in srgb, {accent} 14%, #ffffff)"),
        "headerText": accent,
        "contentBg": "#ffffff",
        "border": format!("color-mix(in srgb, {accent} 24%, #d4d9e1)"),
    })
}

/// 生成暗色主题侧配置（accent 可单独指定暗色变体）。
fn dark_side(accent_light: &str, accent_dark: Option<&str>) -> Value {
    let accent = accent_dark.unwrap_or(accent_light);
    json!({
        "accent": accent,
        "headerBg": format!("color-mix(in srgb, {accent} 18%, #1a2332)"),
        "headerText": format!("color-mix(in srgb, {accent} 82%, #eef0f3)"),
        "contentBg": "#121a24",
        "border": format!("color-mix(in srgb, {accent} 28%, #2f3d4d)"),
    })
}

/// 由 key + index 派生稳定配色（无显式 theme 时的回退）。
fn stable_module_theme(key: &str, index: usize) -> Value {
    let idx = ((hash_string(key) as usize) + index * 137) % MODULE_PALETTE.len();
    let (light, dark) = MODULE_PALETTE[idx];
    json!({ "light": light_side(light), "dark": dark_side(light, Some(dark)) })
}

/// 归一化单侧主题（light 或 dark），缺失字段用 fallback 或由 accent 重新生成。
fn normalize_side(
    side: Option<&Value>,
    fallback: &Value,
    regen_accent: impl Fn(&str) -> Value,
) -> Value {
    let o = match side {
        Some(v) if v.is_object() => v,
        _ => return fallback.clone(),
    };
    let get = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = o.get(*k).and_then(|v| v.as_str()) {
                let c = clean_theme_color(s);
                if !c.is_empty() {
                    return c;
                }
            }
        }
        String::new()
    };
    let accent = {
        let a = get(&["accent", "color"]);
        if a.is_empty() {
            fallback["accent"].as_str().unwrap_or("").to_string()
        } else {
            a
        }
    };
    let generated = regen_accent(&accent);
    let pick = |keys: &[&str], gen_key: &str| -> String {
        let c = get(keys);
        if !c.is_empty() {
            c
        } else {
            generated[gen_key].as_str().unwrap_or("").to_string()
        }
    };
    json!({
        "accent": accent,
        "headerBg": pick(&["headerBg", "headerBackground"], "headerBg"),
        "headerText": pick(&["headerText", "text"], "headerText"),
        "contentBg": pick(&["contentBg", "contentBackground"], "contentBg"),
        "border": pick(&["border", "borderColor"], "border"),
    })
}

/// 解析模块主题：themeColor 优先 -> 显式 raw theme -> 稳定回退。
///
/// # Arguments
///
/// * `module_key` - 模块标识键（如 `domain/app/module`），用于稳定配色 hash。
/// * `raw_theme` - manifest 中显式声明的 theme 对象（可选）。
/// * `index` - 模块序号，用于调色板偏移。
/// * `theme_color_raw` - manifest 中声明的 themeColor 字符串（可选）。
///
/// # Returns
///
/// 包含 `light` 和 `dark` 两侧的主题配置 JSON。
pub fn resolve_module_theme(
    module_key: &str,
    raw_theme: Option<&Value>,
    index: usize,
    theme_color_raw: &str,
) -> Value {
    let key = if module_key.is_empty() {
        "module"
    } else {
        module_key
    };
    let fallback = stable_module_theme(key, index);
    let theme_color = clean_theme_color(theme_color_raw);
    if !theme_color.is_empty() {
        let dark_accent = format!("color-mix(in srgb, {theme_color} 52%, #ffffff)");
        return json!({ "light": light_side(&theme_color), "dark": dark_side(&theme_color, Some(&dark_accent)) });
    }
    let raw = match raw_theme {
        Some(v) if v.is_object() => v,
        _ => return fallback,
    };
    let light_fallback = fallback["light"].clone();
    let dark_fallback = fallback["dark"].clone();
    let light = normalize_side(raw.get("light").or(Some(raw)), &light_fallback, light_side);
    let light_accent = light["accent"].as_str().unwrap_or("");
    let light_fb_accent = light_fallback["accent"].as_str().unwrap_or("");
    let dark_accent = if light_accent != light_fb_accent {
        format!("color-mix(in srgb, {light_accent} 52%, #ffffff)")
    } else {
        dark_fallback["accent"].as_str().unwrap_or("").to_string()
    };
    let da = dark_accent.clone();
    let dark = normalize_side(
        raw.get("dark"),
        &dark_side(light_accent, Some(&dark_accent)),
        move |a| dark_side(a, Some(&da)),
    );
    json!({ "light": light, "dark": dark })
}
