use crate::models::{
    BellSlot, ConsultationSlot, DaySchedule, GroupInfo, LessonItem, TeacherConsultations,
};
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, Utc, Weekday};
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};

pub const CONSULTATIONS_SHEET_ID: &str = "1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies";
pub const CONSULTATIONS_HTMLVIEW_URL: &str =
    "https://docs.google.com/spreadsheets/d/1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies/htmlview";
pub const CONSULTATIONS_CSV_URL: &str =
    "https://docs.google.com/spreadsheets/d/1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies/export?format=csv";
pub const NAVIGATOR_CSV_URL: &str =
    "https://docs.google.com/spreadsheets/d/167kcyEYDRVdzexEauqZDi6uNG3ZFEGe2tvXXl5YERMg/export?format=csv";
pub const NAVIGATOR_GROUPS_HTML_URL: &str =
    "https://docs.google.com/spreadsheets/d/167kcyEYDRVdzexEauqZDi6uNG3ZFEGe2tvXXl5YERMg/htmlview/sheet?headers=true&gid=1600342961";
pub const AKADEMIKS_GROUPS_URL: &str = "https://akademiks.urtt.ru/lk/all-schedules";
pub const AKADEMIKS_TRPC_SCHEDULE: &str = "https://akademiks.urtt.ru/api/trpc/schedule.get";
const MAX_PARSER_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

pub(crate) fn is_allowed_parser_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "akademiks.urtt.ru"
        || h == "docs.google.com"
        || h == "drive.google.com"
        || h.ends_with(".googleusercontent.com")
}

pub(crate) fn is_valid_sheet_gid(gid: &str) -> bool {
    !gid.is_empty() && gid.len() <= 20 && gid.bytes().all(|b| b.is_ascii_digit())
}

fn clean_cell_text(raw: &str, max_chars: usize) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

/// Extracts per-group Google Drive folder URLs from the Distance Navigator HTML sheet,
/// reconstructing canonical `https://drive.google.com/drive/folders/<ID>` links.
pub(crate) fn parse_navigator_drive_urls(html: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let folder_prefix = "drive.google.com/drive/folders/";
    let folder_prefix_enc = "drive.google.com%2Fdrive%2Ffolders%2F";

    let mut pos = 0;
    while let Some(tr_start_rel) = html[pos..].find("<tr") {
        let tr_start = pos + tr_start_rel;
        let Some(tr_end_rel) = html[tr_start..].find("</tr>") else {
            break;
        };
        let row_html = &html[tr_start..tr_start + tr_end_rel];
        pos = tr_start + tr_end_rel + 5;

        // Extract folder ID if present in this row
        let folder_id_opt = row_html
            .find(folder_prefix)
            .map(|i| &row_html[i + folder_prefix.len()..])
            .or_else(|| {
                row_html
                    .find(folder_prefix_enc)
                    .map(|i| &row_html[i + folder_prefix_enc.len()..])
            })
            .map(|tail| {
                tail.chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .collect::<String>()
            })
            .filter(|id| (15..=64).contains(&id.len()));

        let Some(folder_id) = folder_id_opt else {
            continue;
        };

        // Extract plain text cells `<td ...>TEXT</td>` to find the group name (contains '-' and digit)
        let mut td_pos = 0;
        while let Some(td_rel) = row_html[td_pos..].find("<td") {
            let td_open = td_pos + td_rel;
            let Some(gt_rel) = row_html[td_open..].find('>') else {
                break;
            };
            let content_start = td_open + gt_rel + 1;
            let Some(td_close_rel) = row_html[content_start..].find("</td>") else {
                break;
            };
            let cell_inner = row_html[content_start..content_start + td_close_rel].trim();
            td_pos = content_start + td_close_rel + 5;

            if !cell_inner.contains('<')
                && cell_inner.contains('-')
                && cell_inner.chars().any(|c| c.is_ascii_digit())
                && cell_inner.chars().count() <= 20
            {
                map.insert(
                    cell_inner.to_lowercase(),
                    format!("https://drive.google.com/drive/folders/{folder_id}"),
                );
                break;
            }
        }
    }
    map
}

async fn read_bounded_bytes(resp: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if let Some(cl) = resp.content_length() {
        if cl as usize > max_bytes {
            return Err("Ответ сервера превышает допустимый размер.".into());
        }
    }
    let mut out = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| e.to_string())?;
        if out.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Ответ сервера превышает допустимый размер.".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

async fn read_bounded_text(resp: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    let bytes = read_bounded_bytes(resp, max_bytes).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn http_client() -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many redirects");
        }
        let next = attempt.url();
        if next.scheme() != "https" {
            return attempt.error("Non-HTTPS redirect blocked");
        }
        match next.host_str() {
            Some(host) if is_allowed_parser_host(host) => attempt.follow(),
            _ => attempt.error("Redirect to untrusted host blocked"),
        }
    });

    reqwest::Client::builder()
        .user_agent(format!("URTK-Flow/{} (Windows; x64)", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .redirect(policy)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

fn ekb_offset() -> FixedOffset {
    FixedOffset::east_opt(5 * 3600).unwrap()
}

fn weekday_ru(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "Понедельник",
        Weekday::Tue => "Вторник",
        Weekday::Wed => "Среда",
        Weekday::Thu => "Четверг",
        Weekday::Fri => "Пятница",
        Weekday::Sat => "Суббота",
        Weekday::Sun => "Воскресенье",
    }
}

/// Normalizes a Russian teacher name so "Тимонова С.С." matches "Тимонова Светлана Сергеевна".
fn normalize_key(s: &str) -> String {
    s.to_lowercase()
        .replace('ё', "е")
        .replace('.', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Checks if a full name from Google Sheets matches a short/full name from Akademiks.
pub fn teacher_names_match(full_or_sheet: &str, short_or_akademiks: &str) -> bool {
    let a = normalize_key(full_or_sheet);
    let b = normalize_key(short_or_akademiks);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let pa: Vec<&str> = a.split_whitespace().collect();
    let pb: Vec<&str> = b.split_whitespace().collect();
    if pa.is_empty() || pb.is_empty() {
        return false;
    }
    // Surnames must match
    if pa[0] != pb[0] {
        return false;
    }
    if pa.len() == 1 || pb.len() == 1 {
        return true;
    }
    // Compare first initial
    let fa = pa[1].chars().next();
    let fb = pb[1].chars().next();
    if fa != fb {
        return false;
    }
    // Compare patronymic initial if both have it
    if pa.len() >= 3 && pb.len() >= 3 {
        let oa = pa[2].chars().next();
        let ob = pb[2].chars().next();
        if oa != ob {
            return false;
        }
    }
    true
}

/// Extract groups from Akademiks SSR HTML + enrich with Google Sheet Navigator metadata.
pub async fn fetch_groups() -> Result<Vec<GroupInfo>, String> {
    let client = http_client()?;

    // 1. Parse Navigator CSV for course & specialty metadata
    let mut nav_meta: HashMap<String, (String, String, String)> = HashMap::new();
    if let Ok(resp) = client.get(NAVIGATOR_CSV_URL).send().await {
        if let Ok(text) = read_bounded_text(resp, MAX_PARSER_RESPONSE_BYTES).await {
            let mut rdr = csv::ReaderBuilder::new()
                .has_headers(false)
                .flexible(true)
                .from_reader(text.as_bytes());
            for result in rdr.records().flatten() {
                let course = result.get(0).unwrap_or("").trim().to_string();
                let group = result.get(1).unwrap_or("").trim().to_string();
                let code = result.get(2).unwrap_or("").trim().to_string();
                let spec = result.get(3).unwrap_or("").trim().to_string();
                if matches!(course.as_str(), "1" | "2" | "3" | "4") && !group.is_empty() {
                    nav_meta.insert(group.to_lowercase(), (course, code, spec));
                }
            }
        }
    }

    // 1b. Parse per-group Google Drive folder links from Navigator HTML sheet
    let mut drive_map: HashMap<String, String> = HashMap::new();
    if let Ok(resp) = client.get(NAVIGATOR_GROUPS_HTML_URL).send().await {
        if let Ok(nav_html) = read_bounded_text(resp, MAX_PARSER_RESPONSE_BYTES).await {
            drive_map = parse_navigator_drive_urls(&nav_html);
        }
    }

    // 2. Fetch Akademiks /lk/all-schedules to extract real group slugs (id + title)
    let mut groups: Vec<GroupInfo> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    if let Ok(resp) = client.get(AKADEMIKS_GROUPS_URL).send().await {
        if let Ok(html) = read_bounded_text(resp, MAX_PARSER_RESPONSE_BYTES).await {
            // Unescape JSON chunks embedded in Next.js RSC payload
            let unescaped = html.replace("\\\"", "\"");
            let bytes = unescaped.as_bytes();
            let needle = b"\"id\":\"";
            let mut pos = 0;
            while let Some(idx) = find_subsequence(&bytes[pos..], needle) {
                let start = pos + idx + needle.len();
                if let Some(end_id) = unescaped[start..].find('"') {
                    let id_val = &unescaped[start..start + end_id];
                    let after = &unescaped[start + end_id..];
                    // Look for ,"title":"..." right after id (typical Group object)
                    if let Some(rest) = after.strip_prefix("\",\"title\":\"") {
                        if let Some(end_title) = rest.find('"') {
                            let title_val = &rest[..end_title];
                            // Filter only real URTK group titles (contain '-' and digits, e.g. ИсР-101)
                            if title_val.contains('-')
                                && title_val.chars().any(|c| c.is_ascii_digit())
                                && title_val.len() <= 20
                                && !id_val.contains('/')
                                && !seen_ids.contains(id_val)
                            {
                                seen_ids.insert(id_val.to_string());
                                let lower_title = title_val.to_lowercase();
                                let meta = nav_meta.get(&lower_title);
                                groups.push(GroupInfo {
                                    id: id_val.to_string(),
                                    name: title_val.to_string(),
                                    course: meta
                                        .map(|m| m.0.clone())
                                        .unwrap_or_else(|| infer_course(title_val)),
                                    specialty_code: meta.map(|m| m.1.clone()).unwrap_or_default(),
                                    specialty_name: meta.map(|m| m.2.clone()).unwrap_or_default(),
                                    drive_url: drive_map.get(&lower_title).cloned(),
                                });
                            }
                        }
                    }
                    pos = start + end_id;
                } else {
                    break;
                }
            }
        }
    }

    // Fallback: if Akademiks HTML extraction yielded nothing, populate from Navigator CSV
    if groups.is_empty() {
        for (lower_name, (course, code, spec)) in nav_meta {
            let slug = translit_group_slug(&lower_name);
            let drive = drive_map.get(&lower_name).cloned();
            groups.push(GroupInfo {
                id: slug,
                name: lower_name.to_uppercase(),
                course,
                specialty_code: code,
                specialty_name: spec,
                drive_url: drive,
            });
        }
    }

    groups.sort_by(|a, b| a.course.cmp(&b.course).then(a.name.cmp(&b.name)));
    Ok(groups)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn infer_course(group_name: &str) -> String {
    if let Some(idx) = group_name.find('-') {
        if let Some(ch) = group_name[idx + 1..].chars().next() {
            if matches!(ch, '1'..='4') {
                return ch.to_string();
            }
        }
    }
    "1".to_string()
}

fn translit_group_slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.to_lowercase().chars() {
        match ch {
            'а' => out.push('a'),
            'б' => out.push('b'),
            'в' => out.push('v'),
            'г' => out.push('g'),
            'д' => out.push('d'),
            'е' | 'ё' => out.push('e'),
            'ж' => out.push_str("zh"),
            'з' => out.push('z'),
            'и' | 'й' => out.push('i'),
            'к' => out.push('k'),
            'л' => out.push('l'),
            'м' => out.push('m'),
            'н' => out.push('n'),
            'о' => out.push('o'),
            'п' => out.push('p'),
            'р' => out.push('r'),
            'с' => out.push('s'),
            'т' => out.push('t'),
            'у' => out.push('u'),
            'ф' => out.push('f'),
            'х' => out.push('h'),
            'ц' => out.push('c'),
            'ч' => out.push_str("ch"),
            'ш' => out.push_str("sh"),
            'щ' => out.push_str("sch"),
            'ы' => out.push('y'),
            'э' => out.push('e'),
            'ю' => out.push_str("yu"),
            'я' => out.push_str("ya"),
            c if c.is_ascii_alphanumeric() || c == '-' => out.push(c),
            _ => {}
        }
    }
    out
}

/// Fetch schedule for a single week starting on `monday_date` from Akademiks tRPC API.
async fn fetch_week_schedule(
    client: &reqwest::Client,
    group_id: &str,
    monday_date: NaiveDate,
) -> Result<(Vec<DaySchedule>, Vec<String>), String> {
    let tz = ekb_offset();
    let monday_ekb = monday_date
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(tz)
        .unwrap();
    let monday_utc = monday_ekb.with_timezone(&Utc);
    let week_start_iso = monday_utc.format("%Y-%m-%dT%H:%M:%S.000Z").to_string();

    let input_json = serde_json::json!({
        "0": {
            "json": {
                "groupId": group_id,
                "teacherId": null,
                "classroomId": null,
                "weekStart": week_start_iso
            },
            "meta": {
                "values": {
                    "teacherId": ["undefined"],
                    "classroomId": ["undefined"],
                    "weekStart": ["Date"]
                },
                "v": 1
            }
        }
    });

    let encoded_input = url_encode(&input_json.to_string());
    let url = format!("{}?batch=1&input={}", AKADEMIKS_TRPC_SCHEDULE, encoded_input);

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let body = read_bounded_bytes(resp, MAX_PARSER_RESPONSE_BYTES).await?;
    let val: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;

    let mut days = Vec::new();
    let mut teachers_set: HashSet<String> = HashSet::new();

    if let Some(arr) = val
        .get(0)
        .and_then(|v| v.get("result"))
        .and_then(|v| v.get("data"))
        .and_then(|v| v.get("json"))
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
    {
        for day_val in arr {
            let start_str = day_val.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let (date_fmt, weekday_str) = if let Ok(dt) = DateTime::parse_from_rfc3339(start_str) {
                let local = dt.with_timezone(&tz);
                (
                    local.format("%d.%m.%Y").to_string(),
                    weekday_ru(local.weekday()).to_string(),
                )
            } else {
                (start_str.to_string(), "".to_string())
            };

            let mut lessons = Vec::new();
            if let Some(l_arr) = day_val.get("lessons").and_then(|v| v.as_array()) {
                for l in l_arr {
                    let pair_number = l.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let subject = l
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let teacher = l
                        .get("Teacher")
                        .and_then(|t| t.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !teacher.is_empty() {
                        teachers_set.insert(teacher.clone());
                    }
                    let room = l
                        .get("Classroom")
                        .and_then(|c| c.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let time_start = format_utc_to_ekb_hhmm(
                        l.get("start").and_then(|v| v.as_str()).unwrap_or(""),
                    );
                    let time_end = format_utc_to_ekb_hhmm(
                        l.get("end").and_then(|v| v.as_str()).unwrap_or(""),
                    );
                    let lesson_type = l
                        .get("type")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    lessons.push(LessonItem {
                        pair_number,
                        time_start,
                        time_end,
                        subject,
                        teacher,
                        room,
                        lesson_type,
                    });
                }
            }
            lessons.sort_by_key(|l| l.pair_number);
            if !lessons.is_empty() {
                days.push(DaySchedule {
                    date: date_fmt,
                    weekday: weekday_str,
                    lessons,
                });
            }
        }
    }

    let mut teachers: Vec<String> = teachers_set.into_iter().collect();
    teachers.sort();
    Ok((days, teachers))
}

/// Fetch schedule for a specific group from Akademiks tRPC API.
/// On Sunday (or late Saturday), automatically targets the upcoming week starting Monday,
/// falling back to the current week if the next week is not published yet.
/// Also collects teachers across both weeks so teacher matching is complete.
pub async fn fetch_group_schedule(group_id: &str) -> Result<(Vec<DaySchedule>, Vec<String>), String> {
    if group_id.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let client = http_client()?;
    let tz = ekb_offset();
    let now_ekb = Utc::now().with_timezone(&tz);

    let days_from_mon = now_ekb.weekday().num_days_from_monday() as i64;
    let current_monday: NaiveDate = now_ekb.date_naive() - Duration::days(days_from_mon);
    let next_monday: NaiveDate = current_monday + Duration::days(7);

    // If today is Sunday, prioritize next week (starting tomorrow Monday)
    let prefer_next_week = now_ekb.weekday() == Weekday::Sun;

    let (primary_mon, secondary_mon) = if prefer_next_week {
        (next_monday, current_monday)
    } else {
        (current_monday, next_monday)
    };

    let (primary_days, primary_teachers) = fetch_week_schedule(&client, group_id, primary_mon)
        .await
        .unwrap_or_default();
    let (secondary_days, secondary_teachers) =
        fetch_week_schedule(&client, group_id, secondary_mon)
            .await
            .unwrap_or_default();

    let mut all_teachers: HashSet<String> = primary_teachers.into_iter().collect();
    all_teachers.extend(secondary_teachers);
    let mut teachers: Vec<String> = all_teachers.into_iter().collect();
    teachers.sort();

    let days = if !primary_days.is_empty() {
        primary_days
    } else {
        secondary_days
    };

    Ok((days, teachers))
}

fn format_utc_to_ekb_hhmm(iso: &str) -> String {
    if let Ok(dt) = DateTime::parse_from_rfc3339(iso) {
        dt.with_timezone(&ekb_offset())
            .format("%H:%M")
            .to_string()
    } else {
        String::new()
    }
}

fn url_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Parse `dd.mm` or `dd.mm.yyyy` relative to `today`.
fn parse_ru_date(raw: &str, reference: NaiveDate) -> Option<NaiveDate> {
    let cleaned = raw.trim().trim_end_matches('.');
    let parts: Vec<&str> = cleaned.split('.').collect();
    if parts.len() >= 3 {
        let d: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        let mut y: i32 = parts[2].parse().ok()?;
        if y < 100 {
            y += 2000;
        }
        return NaiveDate::from_ymd_opt(y, m, d);
    }
    if parts.len() == 2 {
        let d: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        // Handle year rollover (e.g. Dec -> Jan)
        let mut year = reference.year();
        if reference.month() >= 11 && m <= 2 {
            year += 1;
        } else if reference.month() <= 2 && m >= 11 {
            year -= 1;
        }
        return NaiveDate::from_ymd_opt(year, m, d);
    }
    None
}

/// Extract end-of-slot HH:MM (in minutes from midnight) from strings like "8.00-15.00" or "13:20 - 14:40".
fn parse_slot_end_minutes(time_str: &str) -> Option<u32> {
    let mut times: Vec<u32> = Vec::new();
    let chars: Vec<char> = time_str.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && (chars[i] == ':' || chars[i] == '.') {
                let sep = i;
                i += 1;
                let m_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                let h_str: String = chars[start..sep].iter().collect();
                let m_str: String = chars[m_start..i].iter().collect();
                if m_str.len() == 2 {
                    if let (Ok(h), Ok(m)) = (h_str.parse::<u32>(), m_str.parse::<u32>()) {
                        if h <= 23 && m <= 59 {
                            times.push(h * 60 + m);
                        }
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    times.into_iter().max()
}

/// Returns true only if the consultation date/time has NOT already passed in Yekaterinburg (UTC+5).
fn is_slot_upcoming(date_str: &str, time_str: &str, now_ekb: DateTime<FixedOffset>) -> bool {
    let today = now_ekb.date_naive();
    let Some(slot_date) = parse_ru_date(date_str, today) else {
        return true;
    };
    if slot_date < today {
        return false;
    }
    if slot_date > today {
        return true;
    }
    // Same day: hide if end time already passed
    if let Some(end_min) = parse_slot_end_minutes(time_str) {
        let now_min = now_ekb.format("%H").to_string().parse::<u32>().unwrap_or(0) * 60
            + now_ekb.format("%M").to_string().parse::<u32>().unwrap_or(0);
        return now_min <= end_min;
    }
    true
}

/// Discover all weekly sheet tabs `(tab_name, gid)` from Google Sheets `/htmlview`.
async fn discover_consultation_tabs(client: &reqwest::Client) -> Vec<(String, String)> {
    let mut tabs = Vec::new();
    let Ok(resp) = client.get(CONSULTATIONS_HTMLVIEW_URL).send().await else {
        return tabs;
    };
    let Ok(html) = read_bounded_text(resp, MAX_PARSER_RESPONSE_BYTES).await else {
        return tabs;
    };
    let marker = "items.push({name: \"";
    let mut pos = 0;
    while let Some(idx) = html[pos..].find(marker) {
        let name_start = pos + idx + marker.len();
        let Some(name_end_rel) = html[name_start..].find('"') else {
            break;
        };
        let name = html[name_start..name_start + name_end_rel].trim().to_string();
        let after_name = &html[name_start + name_end_rel..];
        if let Some(gid_idx) = after_name.find("gid: \"") {
            let gid_start = gid_idx + 6;
            if let Some(gid_end) = after_name[gid_start..].find('"') {
                let gid = after_name[gid_start..gid_start + gid_end].to_string();
                if is_valid_sheet_gid(&gid) {
                    tabs.push((name, gid));
                }
            }
        }
        pos = name_start + name_end_rel;
    }
    tabs
}

/// Pick the best upcoming weekly tab(s) whose end date >= today.
fn pick_active_gids(tabs: &[(String, String)], today: NaiveDate) -> Vec<(String, String)> {
    let mut scored: Vec<(NaiveDate, NaiveDate, String, String)> = Vec::new();
    for (name, gid) in tabs {
        // Parse ranges like "23.11 - 28.11" or "16.11 - 21.11."
        let parts: Vec<&str> = name.split(['-', '–', '—']).collect();
        if parts.len() >= 2 {
            if let (Some(start_d), Some(end_d)) = (
                parse_ru_date(parts[0], today),
                parse_ru_date(parts[1], today),
            ) {
                if end_d >= today {
                    scored.push((start_d, end_d, name.clone(), gid.clone()));
                }
            }
        }
    }
    scored.sort_by_key(|x| x.0);

    let mut chosen = Vec::new();
    if let Some(first) = scored.first() {
        chosen.push((first.2.clone(), first.3.clone()));
        // If current active tab ends within 2 days (e.g., Fri/Sat), also include the following week
        if (first.1 - today).num_days() <= 2 {
            if let Some(second) = scored.get(1) {
                chosen.push((second.2.clone(), second.3.clone()));
            }
        }
    }
    chosen
}

pub fn sort_consultations(results: &mut [TeacherConsultations]) {
    results.sort_by(|a, b| {
        let score = |x: &TeacherConsultations| -> u8 {
            let active = !x.slots.is_empty();
            if x.is_pinned && active {
                0
            } else if x.is_pinned {
                1
            } else if x.is_my_teacher && active {
                2
            } else if x.is_my_teacher {
                3
            } else if active {
                4
            } else {
                5
            }
        };
        score(a)
            .cmp(&score(b))
            .then(a.teacher_name.cmp(&b.teacher_name))
    });
}

/// Fetch and parse Google Sheets consultations CSV across the active upcoming weekly tab(s),
/// automatically skipping past weeks and past consultation slots.
/// Returns (week_range, Vec<TeacherConsultations>).
pub async fn fetch_consultations(
    group_teachers: &[String],
    pinned_teachers: &[String],
) -> Result<(String, Vec<TeacherConsultations>), String> {
    let client = http_client()?;
    let now_ekb = Utc::now().with_timezone(&ekb_offset());
    let today = now_ekb.date_naive();

    let tabs = discover_consultation_tabs(&client).await;
    let active_tabs = pick_active_gids(&tabs, today);

    let csv_urls: Vec<String> = if active_tabs.is_empty() {
        vec![CONSULTATIONS_CSV_URL.to_string()]
    } else {
        active_tabs
            .iter()
            .map(|(_, gid)| {
                format!(
                    "https://docs.google.com/spreadsheets/d/{}/export?format=csv&gid={}",
                    CONSULTATIONS_SHEET_ID, gid
                )
            })
            .collect()
    };

    let mut teacher_map: HashMap<String, Vec<ConsultationSlot>> = HashMap::new();
    let mut all_dates: Vec<(NaiveDate, String)> = Vec::new();

    for url in csv_urls {
        let Ok(resp) = client.get(&url).send().await else {
            continue;
        };
        let Ok(csv_text) = read_bounded_text(resp, MAX_PARSER_RESPONSE_BYTES).await else {
            continue;
        };

        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(csv_text.as_bytes());

        let rows: Vec<Vec<String>> = rdr
            .records()
            .flatten()
            .map(|rec| rec.iter().map(|s| s.trim().to_string()).collect())
            .collect();

        if rows.len() < 3 {
            continue;
        }

        let weekdays = &rows[0];
        let dates = &rows[1];

        let day_cols: Vec<(usize, String, String)> = (3..weekdays.len())
            .filter_map(|col| {
                let wd = weekdays.get(col).cloned().unwrap_or_default();
                let dt = dates.get(col).cloned().unwrap_or_default();
                if wd.is_empty() && dt.is_empty() {
                    None
                } else {
                    if let Some(parsed) = parse_ru_date(&dt, today) {
                        if parsed >= today {
                            all_dates.push((parsed, dt.clone()));
                        }
                    }
                    Some((col, wd, dt))
                }
            })
            .collect();

        let mut i = 2;
        while i < rows.len() {
            let row = &rows[i];
            let teacher_name = clean_cell_text(row.get(1).map(|s| s.as_str()).unwrap_or(""), 140);
            if !teacher_name.is_empty() && teacher_name != "ФИО преподавателя" {
                let next_row = rows.get(i + 1);
                let entry = teacher_map.entry(teacher_name).or_default();

                for (col, wd, dt) in &day_cols {
                    let time_val = clean_cell_text(row.get(*col).map(|s| s.as_str()).unwrap_or(""), 64);
                    let loc_val = clean_cell_text(
                        next_row
                            .and_then(|nr| nr.get(*col))
                            .map(|s| s.as_str())
                            .unwrap_or(""),
                        512,
                    );

                    if (!time_val.is_empty() || !loc_val.is_empty())
                        && is_slot_upcoming(dt, &time_val, now_ekb)
                    {
                        entry.push(ConsultationSlot {
                            weekday: clean_cell_text(wd, 32),
                            date: clean_cell_text(dt, 24),
                            time: if time_val.is_empty() {
                                "По записи".to_string()
                            } else {
                                time_val
                            },
                            location: loc_val,
                        });
                    }
                }
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    all_dates.sort_by_key(|x| x.0);
    let week_range = if let (Some(first), Some(last)) = (all_dates.first(), all_dates.last()) {
        format!("{} — {}", first.1, last.1)
    } else if let Some((name, _)) = active_tabs.first() {
        name.clone()
    } else {
        "Актуальная неделя".to_string()
    };

    let mut results: Vec<TeacherConsultations> = teacher_map
        .into_iter()
        .map(|(teacher_name, slots)| {
            let is_my = group_teachers
                .iter()
                .any(|gt| teacher_names_match(&teacher_name, gt));
            let is_pinned = pinned_teachers
                .iter()
                .any(|pt| teacher_names_match(&teacher_name, pt));
            TeacherConsultations {
                teacher_name,
                is_my_teacher: is_my,
                is_pinned,
                slots,
            }
        })
        .collect();

    sort_consultations(&mut results);

    Ok((week_range, results))
}

pub fn urtk_bells_monday() -> Vec<BellSlot> {
    vec![
        BellSlot { pair_number: 1, part1: "08:00–08:45".into(), part2: "08:50–09:35".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 2, part1: "09:45–10:30".into(), part2: "10:35–11:20".into(), break_after: "30 мин".into() },
        BellSlot { pair_number: 3, part1: "11:50–12:35".into(), part2: "12:40–13:25".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 4, part1: "13:35–14:20".into(), part2: "14:25–15:10".into(), break_after: "30 мин".into() },
        BellSlot { pair_number: 5, part1: "15:40–16:25".into(), part2: "16:30–17:15".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 6, part1: "17:25–18:10".into(), part2: "18:15–19:00".into(), break_after: "—".into() },
    ]
}

pub fn urtk_bells_regular() -> Vec<BellSlot> {
    vec![
        BellSlot { pair_number: 1, part1: "08:00–08:45".into(), part2: "08:50–09:35".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 2, part1: "09:45–10:30".into(), part2: "10:35–11:20".into(), break_after: "20 мин".into() },
        BellSlot { pair_number: 3, part1: "11:40–12:25".into(), part2: "12:30–13:15".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 4, part1: "13:25–14:10".into(), part2: "14:15–15:00".into(), break_after: "20 мин".into() },
        BellSlot { pair_number: 5, part1: "15:20–16:05".into(), part2: "16:10–16:55".into(), break_after: "10 мин".into() },
        BellSlot { pair_number: 6, part1: "17:05–17:50".into(), part2: "17:55–18:40".into(), break_after: "—".into() },
    ]
}

#[cfg(test)]
mod parser_security_tests {
    use super::*;

    #[test]
    fn parser_host_allowlist_and_gid_validation() {
        assert!(is_allowed_parser_host("akademiks.urtt.ru"));
        assert!(is_allowed_parser_host("docs.google.com"));
        assert!(is_allowed_parser_host("doc-0s-1a-sheets.googleusercontent.com"));
        assert!(!is_allowed_parser_host("evil.example"));
        assert!(!is_allowed_parser_host("docs.google.com.evil.example"));
        assert!(!is_allowed_parser_host("127.0.0.1"));

        assert!(is_valid_sheet_gid("0"));
        assert!(is_valid_sheet_gid("184729104"));
        assert!(!is_valid_sheet_gid(""));
        assert!(!is_valid_sheet_gid("123&format=html"));
        assert!(!is_valid_sheet_gid("../evil"));

        let sample_html = r#"<tr><td>1</td><td>Би-131</td><td><a href="https://www.google.com/url?q=https://drive.google.com/drive/folders/17T4G7gCd2KyZMpgAELcR9uCAe71Re5Tc&amp;sa=D">Открыть папку</a></td></tr>"#;
        let parsed = parse_navigator_drive_urls(sample_html);
        assert_eq!(
            parsed.get("би-131").map(|s| s.as_str()),
            Some("https://drive.google.com/drive/folders/17T4G7gCd2KyZMpgAELcR9uCAe71Re5Tc")
        );

        let mut items = vec![
            TeacherConsultations {
                teacher_name: "Абрамов Иван".into(),
                is_my_teacher: true,
                is_pinned: false,
                slots: vec![ConsultationSlot {
                    weekday: "Ср".into(),
                    date: "25.11".into(),
                    time: "13:00".into(),
                    location: "215".into(),
                }],
            },
            TeacherConsultations {
                teacher_name: "Яковлева Ольга".into(),
                is_my_teacher: true,
                is_pinned: true,
                slots: vec![ConsultationSlot {
                    weekday: "Чт".into(),
                    date: "26.11".into(),
                    time: "14:00".into(),
                    location: "310".into(),
                }],
            },
        ];
        sort_consultations(&mut items);
        assert_eq!(items[0].teacher_name, "Яковлева Ольга");
    }
}
