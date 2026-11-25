<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

$reqMethod = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($reqMethod !== 'GET' && $reqMethod !== 'HEAD') {
    http_response_code(405);
    header('Allow: GET, HEAD');
    echo json_encode(['ok' => false, 'error' => 'Method Not Allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

date_default_timezone_set('Asia/Yekaterinburg');

const CONSULTATIONS_SHEET_ID = '1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies';
const CONSULTATIONS_HTMLVIEW = 'https://docs.google.com/spreadsheets/d/1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies/htmlview';
const NAVIGATOR_CSV = 'https://docs.google.com/spreadsheets/d/167kcyEYDRVdzexEauqZDi6uNG3ZFEGe2tvXXl5YERMg/export?format=csv';
const NAVIGATOR_GROUPS_HTML = 'https://docs.google.com/spreadsheets/d/167kcyEYDRVdzexEauqZDi6uNG3ZFEGe2tvXXl5YERMg/htmlview/sheet?headers=true&gid=1600342961';
const AKADEMIKS_GROUPS_URL = 'https://akademiks.urtt.ru/lk/all-schedules';
const AKADEMIKS_TRPC_SCHEDULE = 'https://akademiks.urtt.ru/api/trpc/schedule.get';
const MAX_UPSTREAM_BYTES = 5242880; // 5 MiB hard ceiling
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_REQ = 45;
const STALE_CACHE_MAX_AGE_SEC = 86400;

function cache_dir(): string {
    // Private per-site cache directory (isolated from shared /tmp on multi-tenant hosting)
    $dir = __DIR__ . '/.cache';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $ht = $dir . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "Require all denied\nDeny from all\n");
    }
    $idx = $dir . '/index.php';
    if (!is_file($idx)) {
        @file_put_contents($idx, "<?php http_response_code(403); exit;\n");
    }
    return $dir;
}

function enforce_rate_limit(): void {
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $dir = cache_dir();
    $rlFile = $dir . '/rl_' . hash('sha256', $ip) . '.json';
    $now = time();

    $fp = @fopen($rlFile, 'c+');
    if ($fp === false) {
        return;
    }
    if (@flock($fp, LOCK_EX)) {
        $raw = stream_get_contents($fp);
        $hits = is_string($raw) && $raw !== '' ? json_decode($raw, true) : [];
        if (!is_array($hits)) {
            $hits = [];
        }
        $cutoff = $now - RATE_LIMIT_WINDOW_SEC;
        $hits = array_values(array_filter($hits, static fn($ts) => is_int($ts) && $ts >= $cutoff));
        if (count($hits) >= RATE_LIMIT_MAX_REQ) {
            @flock($fp, LOCK_UN);
            fclose($fp);
            http_response_code(429);
            header('Retry-After: 30');
            echo json_encode(['ok' => false, 'error' => 'Слишком много запросов. Повторите через минуту.'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $hits[] = $now;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($hits));
        fflush($fp);
        @flock($fp, LOCK_UN);
    }
    fclose($fp);

    if (random_int(1, 80) === 1) {
        $oldCutoff = $now - 300;
        foreach (glob($dir . '/rl_*.json') ?: [] as $f) {
            if (is_file($f) && !is_link($f) && (int)filemtime($f) < $oldCutoff) {
                @unlink($f);
            }
        }
    }
}

function cache_get(string $key, int $ttl): ?string {
    $file = cache_dir() . '/' . hash('sha256', $key) . '.cache';
    if (is_file($file) && !is_link($file) && (time() - (int)filemtime($file)) < $ttl) {
        $data = @file_get_contents($file);
        if ($data !== false && $data !== '') {
            return $data;
        }
    }
    return null;
}

function cache_set(string $key, string $value): void {
    $dir = cache_dir();
    $target = $dir . '/' . hash('sha256', $key) . '.cache';
    $tmp = @tempnam($dir, 'tmp_');
    if ($tmp !== false) {
        if (@file_put_contents($tmp, $value, LOCK_EX) !== false) {
            @chmod($tmp, 0600);
            @rename($tmp, $target);
        } else {
            @unlink($tmp);
        }
    }
    // Opportunistic cleanup of stale cache & lock files (> 24h)
    if (random_int(1, 50) === 1) {
        $cutoff = time() - STALE_CACHE_MAX_AGE_SEC;
        foreach (array_merge(glob($dir . '/*.cache') ?: [], glob($dir . '/*.lock') ?: []) as $f) {
            if (is_file($f) && !is_link($f) && (int)filemtime($f) < $cutoff) {
                @unlink($f);
            }
        }
    }
}

function http_get(string $url, int $ttl = 0, int $timeout = 14): ?string {
    if (!str_starts_with($url, 'https://')) {
        return null;
    }
    if ($ttl > 0) {
        $cached = cache_get($url, $ttl);
        if ($cached !== null) {
            return $cached;
        }
    }

    // Singleflight per-URL lock prevents cache stampede across concurrent PHP workers
    $lockFp = null;
    if ($ttl > 0) {
        $lockPath = cache_dir() . '/' . hash('sha256', $url) . '.lock';
        $lockFp = @fopen($lockPath, 'c');
        if ($lockFp !== false) {
            @flock($lockFp, LOCK_EX);
            // Re-check cache after acquiring lock in case another worker just populated it
            $fresh = cache_get($url, $ttl);
            if ($fresh !== null) {
                @flock($lockFp, LOCK_UN);
                fclose($lockFp);
                return $fresh;
            }
        }
    }

    $body = null;
    try {
        if (function_exists('curl_init')) {
            $buffer = '';
            $overflow = false;
            $ch = curl_init($url);
            $opts = [
                CURLOPT_RETURNTRANSFER => false,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 4,
                CURLOPT_TIMEOUT => $timeout,
                CURLOPT_CONNECTTIMEOUT => 8,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_USERAGENT => 'URTK-Flow-PWA/1.2 (PHP)',
                CURLOPT_ENCODING => '',
                CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$buffer, &$overflow): int {
                    if (strlen($buffer) + strlen($chunk) > MAX_UPSTREAM_BYTES) {
                        $overflow = true;
                        return 0;
                    }
                    $buffer .= $chunk;
                    return strlen($chunk);
                },
            ];
            if (defined('CURLPROTO_HTTPS')) {
                $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
                $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTPS;
            }
            curl_setopt_array($ch, $opts);
            $ok = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($ok !== false && !$overflow && $code >= 200 && $code < 300) {
                $body = $buffer;
            }
        } else {
            $ctx = stream_context_create([
                'http' => [
                    'timeout' => $timeout,
                    'header' => "User-Agent: URTK-Flow-PWA/1.2 (PHP)\r\n",
                ],
                'ssl' => [
                    'verify_peer' => true,
                    'verify_peer_name' => true,
                ],
            ]);
            $res = @file_get_contents($url, false, $ctx, 0, MAX_UPSTREAM_BYTES);
            if ($res !== false) {
                $body = (string)$res;
            }
        }

        if ($body !== null && $ttl > 0) {
            cache_set($url, $body);
        } elseif ($body === null && $ttl > 0) {
            // Stale-while-error fallback when upstream is temporarily unreachable
            $body = cache_get($url, STALE_CACHE_MAX_AGE_SEC);
        }
    } finally {
        if ($lockFp !== null && $lockFp !== false) {
            @flock($lockFp, LOCK_UN);
            fclose($lockFp);
        }
    }

    return $body;
}

function parse_csv_rows(string $csv): array {
    $rows = [];
    $fp = fopen('php://temp', 'r+');
    fwrite($fp, $csv);
    rewind($fp);
    while (($row = fgetcsv($fp)) !== false) {
        $rows[] = array_map(static fn($v) => trim((string)$v), $row);
    }
    fclose($fp);
    return $rows;
}

function normalize_teacher_key(string $s): string {
    $s = mb_strtolower($s, 'UTF-8');
    $s = str_replace(['ё', '.'], ['е', ' '], $s);
    $parts = preg_split('/\s+/u', trim($s)) ?: [];
    return implode(' ', $parts);
}

function teacher_names_match(string $aRaw, string $bRaw): bool {
    $a = normalize_teacher_key($aRaw);
    $b = normalize_teacher_key($bRaw);
    if ($a === '' || $b === '') return false;
    if ($a === $b) return true;
    $pa = explode(' ', $a);
    $pb = explode(' ', $b);
    if ($pa[0] !== $pb[0]) return false;
    if (count($pa) === 1 || count($pb) === 1) return true;
    if (mb_substr($pa[1], 0, 1, 'UTF-8') !== mb_substr($pb[1], 0, 1, 'UTF-8')) return false;
    if (count($pa) >= 3 && count($pb) >= 3) {
        if (mb_substr($pa[2], 0, 1, 'UTF-8') !== mb_substr($pb[2], 0, 1, 'UTF-8')) return false;
    }
    return true;
}

function weekday_ru(int $isoDay): string {
    return match ($isoDay) {
        1 => 'Понедельник',
        2 => 'Вторник',
        3 => 'Среда',
        4 => 'Четверг',
        5 => 'Пятница',
        6 => 'Суббота',
        default => 'Воскресенье',
    };
}

function infer_course(string $groupName): string {
    $pos = strpos($groupName, '-');
    if ($pos !== false && isset($groupName[$pos + 1]) && ctype_digit($groupName[$pos + 1])) {
        $d = $groupName[$pos + 1];
        if ($d >= '1' && $d <= '4') return $d;
    }
    return '1';
}

function clean_cell_str(string $raw, int $maxLen = 256): string {
    $clean = preg_replace('/[\x00-\x1F\x7F]/u', '', $raw) ?? '';
    return mb_substr(trim($clean), 0, $maxLen, 'UTF-8');
}

function parse_navigator_drive_urls(string $html): array {
    $map = [];
    if (preg_match_all('/<tr[^>]*>(.*?)<\/tr>/su', $html, $rows)) {
        foreach ($rows[1] as $rowHtml) {
            if (!preg_match('/drive\.google\.com(?:\/|%2F)drive(?:\/|%2F)folders(?:\/|%2F)([A-Za-z0-9_-]{15,64})/i', $rowHtml, $fm)) {
                continue;
            }
            $folderId = $fm[1];
            if (preg_match_all('/<td[^>]*>([^<]{2,24})<\/td>/u', $rowHtml, $cells)) {
                foreach ($cells[1] as $cellTxt) {
                    $txt = trim($cellTxt);
                    if (strpos($txt, '-') !== false && preg_match('/\d/', $txt)) {
                        $map[mb_strtolower($txt, 'UTF-8')] = 'https://drive.google.com/drive/folders/' . $folderId;
                        break;
                    }
                }
            }
        }
    }
    return $map;
}

function fetch_groups(): array {
    $navMeta = [];
    $navCsv = http_get(NAVIGATOR_CSV, 3600);
    if ($navCsv !== null) {
        foreach (parse_csv_rows($navCsv) as $r) {
            $course = $r[0] ?? '';
            $group = $r[1] ?? '';
            if (in_array($course, ['1', '2', '3', '4'], true) && $group !== '') {
                $navMeta[mb_strtolower($group, 'UTF-8')] = [
                    'course' => $course,
                    'code' => clean_cell_str($r[2] ?? '', 32),
                    'spec' => clean_cell_str($r[3] ?? '', 180),
                ];
            }
        }
    }

    $driveMap = [];
    $navHtml = http_get(NAVIGATOR_GROUPS_HTML, 3600);
    if ($navHtml !== null) {
        $driveMap = parse_navigator_drive_urls($navHtml);
    }

    $groups = [];
    $seen = [];
    $html = http_get(AKADEMIKS_GROUPS_URL, 3600);
    if ($html !== null) {
        $unescaped = str_replace('\\"', '"', $html);
        if (preg_match_all('/"id":"([^"\/]{2,30})","title":"([^"]{2,20})"/u', $unescaped, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $id = $m[1];
                $title = $m[2];
                if (strpos($title, '-') !== false && preg_match('/\d/', $title) && !isset($seen[$id])) {
                    $seen[$id] = true;
                    $lower = mb_strtolower($title, 'UTF-8');
                    $meta = $navMeta[$lower] ?? null;
                    $groups[] = [
                        'id' => $id,
                        'name' => $title,
                        'course' => $meta['course'] ?? infer_course($title),
                        'specialtyCode' => $meta['code'] ?? '',
                        'specialtyName' => $meta['spec'] ?? '',
                        'driveUrl' => $driveMap[$lower] ?? null,
                    ];
                }
            }
        }
    }

    usort($groups, static function ($a, $b) {
        return [$a['course'], $a['name']] <=> [$b['course'], $b['name']];
    });
    return $groups;
}

function fetch_week_schedule(string $groupId, DateTimeImmutable $mondayEkb): array {
    $utcTz = new DateTimeZone('UTC');
    $ekbTz = new DateTimeZone('Asia/Yekaterinburg');
    $weekStartIso = $mondayEkb->setTimezone($utcTz)->format('Y-m-d\TH:i:s.000\Z');

    $input = json_encode((object)[
        '0' => [
            'json' => [
                'groupId' => $groupId,
                'teacherId' => null,
                'classroomId' => null,
                'weekStart' => $weekStartIso,
            ],
            'meta' => [
                'values' => [
                    'teacherId' => ['undefined'],
                    'classroomId' => ['undefined'],
                    'weekStart' => ['Date'],
                ],
                'v' => 1,
            ],
        ],
    ], JSON_UNESCAPED_SLASHES);

    $url = AKADEMIKS_TRPC_SCHEDULE . '?batch=1&input=' . rawurlencode((string)$input);
    $raw = http_get($url, 600);
    if ($raw === null) {
        return [[], []];
    }

    $json = json_decode($raw, true);
    $arr = $json[0]['result']['data']['json']['data'] ?? [];
    if (!is_array($arr)) {
        return [[], []];
    }

    $days = [];
    $teachers = [];
    foreach ($arr as $dayVal) {
        $startStr = (string)($dayVal['start'] ?? '');
        try {
            $dt = (new DateTimeImmutable($startStr))->setTimezone($ekbTz);
            $dateFmt = $dt->format('d.m.Y');
            $wd = weekday_ru((int)$dt->format('N'));
        } catch (Throwable) {
            $dateFmt = $startStr;
            $wd = '';
        }

        $lessons = [];
        foreach (($dayVal['lessons'] ?? []) as $l) {
            $teacher = trim((string)($l['Teacher']['name'] ?? ''));
            if ($teacher !== '') {
                $teachers[$teacher] = true;
            }
            $tStart = '';
            $tEnd = '';
            try {
                $tStart = (new DateTimeImmutable((string)($l['start'] ?? '')))->setTimezone($ekbTz)->format('H:i');
                $tEnd = (new DateTimeImmutable((string)($l['end'] ?? '')))->setTimezone($ekbTz)->format('H:i');
            } catch (Throwable) {
            }
            $lessons[] = [
                'pairNumber' => (int)($l['index'] ?? 0),
                'timeStart' => $tStart,
                'timeEnd' => $tEnd,
                'subject' => trim((string)($l['title'] ?? '')),
                'teacher' => $teacher,
                'room' => trim((string)($l['Classroom']['name'] ?? '')),
            ];
        }
        usort($lessons, static fn($a, $b) => $a['pairNumber'] <=> $b['pairNumber']);
        if (!empty($lessons)) {
            $days[] = [
                'date' => $dateFmt,
                'weekday' => $wd,
                'lessons' => $lessons,
            ];
        }
    }

    $tList = array_keys($teachers);
    sort($tList);
    return [$days, $tList];
}

function fetch_group_schedule(string $groupId): array {
    if ($groupId === '') return [[], []];
    $ekbTz = new DateTimeZone('Asia/Yekaterinburg');
    $now = new DateTimeImmutable('now', $ekbTz);
    $isoDay = (int)$now->format('N'); // 1..7
    $currentMonday = $now->setTime(0, 0, 0)->modify('-' . ($isoDay - 1) . ' days');
    $nextMonday = $currentMonday->modify('+7 days');

    $preferNext = ($isoDay === 7);
    $primaryMon = $preferNext ? $nextMonday : $currentMonday;
    $secondaryMon = $preferNext ? $currentMonday : $nextMonday;

    [$primaryDays, $primaryTeachers] = fetch_week_schedule($groupId, $primaryMon);
    [$secondaryDays, $secondaryTeachers] = fetch_week_schedule($groupId, $secondaryMon);

    $allTeachers = array_values(array_unique(array_merge($primaryTeachers, $secondaryTeachers)));
    sort($allTeachers);
    $days = !empty($primaryDays) ? $primaryDays : $secondaryDays;
    return [$days, $allTeachers];
}

function parse_ru_date(string $raw, DateTimeImmutable $ref): ?DateTimeImmutable {
    $clean = rtrim(trim($raw), '.');
    $parts = explode('.', $clean);
    $ekbTz = new DateTimeZone('Asia/Yekaterinburg');
    if (count($parts) >= 3) {
        $d = (int)$parts[0];
        $m = (int)$parts[1];
        $y = (int)$parts[2];
        if ($y < 100) $y += 2000;
        if (checkdate($m, $d, $y)) {
            return new DateTimeImmutable(sprintf('%04d-%02d-%02d 00:00:00', $y, $m, $d), $ekbTz);
        }
    } elseif (count($parts) === 2) {
        $d = (int)$parts[0];
        $m = (int)$parts[1];
        $refM = (int)$ref->format('n');
        $y = (int)$ref->format('Y');
        if ($refM >= 11 && $m <= 2) $y++;
        elseif ($refM <= 2 && $m >= 11) $y--;
        if (checkdate($m, $d, $y)) {
            return new DateTimeImmutable(sprintf('%04d-%02d-%02d 00:00:00', $y, $m, $d), $ekbTz);
        }
    }
    return null;
}

function parse_slot_end_minutes(string $timeStr): ?int {
    if (!preg_match_all('/(\d{1,2})[:.](\d{2})/', $timeStr, $m, PREG_SET_ORDER)) {
        return null;
    }
    $max = null;
    foreach ($m as $pair) {
        $h = (int)$pair[1];
        $min = (int)$pair[2];
        if ($h <= 23 && $min <= 59) {
            $tot = $h * 60 + $min;
            if ($max === null || $tot > $max) $max = $tot;
        }
    }
    return $max;
}

function is_slot_upcoming(string $dateStr, string $timeStr, DateTimeImmutable $now): bool {
    $today = $now->setTime(0, 0, 0);
    $slotDate = parse_ru_date($dateStr, $today);
    if ($slotDate === null) return true;
    if ($slotDate < $today) return false;
    if ($slotDate > $today) return true;
    $endMin = parse_slot_end_minutes($timeStr);
    if ($endMin !== null) {
        $nowMin = ((int)$now->format('G')) * 60 + ((int)$now->format('i'));
        return $nowMin <= $endMin;
    }
    return true;
}

function fetch_consultations(array $groupTeachers): array {
    $ekbTz = new DateTimeZone('Asia/Yekaterinburg');
    $now = new DateTimeImmutable('now', $ekbTz);
    $today = $now->setTime(0, 0, 0);

    $html = http_get(CONSULTATIONS_HTMLVIEW, 900);
    $scored = [];
    if ($html !== null && preg_match_all('/items\.push\(\{name:\s*"([^"]+)",[^}]*gid:\s*"(\d+)"/', $html, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $m) {
            $name = trim($m[1]);
            $gid = $m[2];
            $parts = preg_split('/[-–—]/u', $name) ?: [];
            if (count($parts) >= 2) {
                $s = parse_ru_date($parts[0], $today);
                $e = parse_ru_date($parts[1], $today);
                if ($s !== null && $e !== null && $e >= $today) {
                    $scored[] = ['start' => $s, 'end' => $e, 'name' => $name, 'gid' => $gid];
                }
            }
        }
    }
    usort($scored, static fn($a, $b) => $a['start'] <=> $b['start']);

    $activeTabs = [];
    if (!empty($scored)) {
        $activeTabs[] = $scored[0];
        $daysLeft = (int)$today->diff($scored[0]['end'])->format('%r%a');
        if ($daysLeft <= 2 && isset($scored[1])) {
            $activeTabs[] = $scored[1];
        }
    }

    $urls = [];
    if (empty($activeTabs)) {
        $urls[] = 'https://docs.google.com/spreadsheets/d/' . CONSULTATIONS_SHEET_ID . '/export?format=csv';
    } else {
        foreach ($activeTabs as $t) {
            $urls[] = 'https://docs.google.com/spreadsheets/d/' . CONSULTATIONS_SHEET_ID . '/export?format=csv&gid=' . $t['gid'];
        }
    }

    $teacherMap = [];
    $allDates = [];
    foreach ($urls as $u) {
        $csv = http_get($u, 600);
        if ($csv === null) continue;
        $rows = parse_csv_rows($csv);
        if (count($rows) < 3) continue;

        $weekdays = $rows[0];
        $dates = $rows[1];
        $dayCols = [];
        for ($col = 3, $len = count($weekdays); $col < $len; $col++) {
            $wd = $weekdays[$col] ?? '';
            $dt = $dates[$col] ?? '';
            if ($wd !== '' || $dt !== '') {
                $parsed = parse_ru_date($dt, $today);
                if ($parsed !== null && $parsed >= $today) {
                    $allDates[$parsed->format('Y-m-d')] = $dt;
                }
                $dayCols[] = [$col, $wd, $dt];
            }
        }

        $i = 2;
        $n = count($rows);
        while ($i < $n) {
            $row = $rows[$i];
            $tName = clean_cell_str($row[1] ?? '', 140);
            if ($tName !== '' && $tName !== 'ФИО преподавателя') {
                $nextRow = $rows[$i + 1] ?? [];
                if (!isset($teacherMap[$tName])) {
                    $teacherMap[$tName] = [];
                }
                foreach ($dayCols as [$col, $wd, $dt]) {
                    $timeVal = clean_cell_str($row[$col] ?? '', 64);
                    $locVal = clean_cell_str($nextRow[$col] ?? '', 512);
                    if (($timeVal !== '' || $locVal !== '') && is_slot_upcoming($dt, $timeVal, $now)) {
                        $teacherMap[$tName][] = [
                            'weekday' => clean_cell_str($wd, 32),
                            'date' => clean_cell_str($dt, 24),
                            'time' => $timeVal !== '' ? $timeVal : 'По записи',
                            'location' => $locVal,
                        ];
                    }
                }
                $i += 2;
            } else {
                $i += 1;
            }
        }
    }

    ksort($allDates);
    $dateVals = array_values($allDates);
    $weekRange = !empty($dateVals)
        ? ($dateVals[0] . ' — ' . end($dateVals))
        : ($activeTabs[0]['name'] ?? 'Актуальная неделя');

    $results = [];
    foreach ($teacherMap as $tName => $slots) {
        $isMy = false;
        foreach ($groupTeachers as $gt) {
            if (teacher_names_match($tName, $gt)) {
                $isMy = true;
                break;
            }
        }
        $results[] = [
            'teacherName' => $tName,
            'isMyTeacher' => $isMy,
            'slots' => $slots,
        ];
    }

    usort($results, static function ($a, $b) {
        $score = static function ($x) {
            $mine = $x['isMyTeacher'];
            $act = !empty($x['slots']);
            if ($mine && $act) return 0;
            if ($mine) return 1;
            if ($act) return 2;
            return 3;
        };
        return [$score($a), $a['teacherName']] <=> [$score($b), $b['teacherName']];
    });

    return [$weekRange, $results];
}

function bells_data(): array {
    return [
        'monday' => [
            ['pairNumber' => 1, 'part1' => '08:00–08:45', 'part2' => '08:50–09:35'],
            ['pairNumber' => 2, 'part1' => '09:45–10:30', 'part2' => '10:35–11:20'],
            ['pairNumber' => 3, 'part1' => '11:50–12:35', 'part2' => '12:40–13:25'],
            ['pairNumber' => 4, 'part1' => '13:35–14:20', 'part2' => '14:25–15:10'],
            ['pairNumber' => 5, 'part1' => '15:40–16:25', 'part2' => '16:30–17:15'],
            ['pairNumber' => 6, 'part1' => '17:25–18:10', 'part2' => '18:15–19:00'],
        ],
        'regular' => [
            ['pairNumber' => 1, 'part1' => '08:00–08:45', 'part2' => '08:50–09:35'],
            ['pairNumber' => 2, 'part1' => '09:45–10:30', 'part2' => '10:35–11:20'],
            ['pairNumber' => 3, 'part1' => '11:40–12:25', 'part2' => '12:30–13:15'],
            ['pairNumber' => 4, 'part1' => '13:25–14:10', 'part2' => '14:15–15:00'],
            ['pairNumber' => 5, 'part1' => '15:20–16:05', 'part2' => '16:10–16:55'],
            ['pairNumber' => 6, 'part1' => '17:05–17:50', 'part2' => '17:55–18:40'],
        ],
    ];
}

try {
    enforce_rate_limit();
    $rawGroup = is_string($_GET['group'] ?? null) ? $_GET['group'] : '';
    $selectedGroup = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $rawGroup) ?? '');
    if (mb_strlen($selectedGroup, 'UTF-8') > 40) {
        $selectedGroup = '';
    }
    $groups = fetch_groups();

    // Strict allowlist: only query Akademiks for real groups from the official URTK list
    $groupId = '';
    $matchedGroup = '';
    if ($selectedGroup !== '') {
        foreach ($groups as $g) {
            if (mb_strtolower($g['name'], 'UTF-8') === mb_strtolower($selectedGroup, 'UTF-8') || $g['id'] === $selectedGroup) {
                $groupId = $g['id'];
                $matchedGroup = $g['name'];
                break;
            }
        }
    }

    [$schedule, $groupTeachers] = $groupId !== '' ? fetch_group_schedule($groupId) : [[], []];
    [$weekRange, $consultations] = fetch_consultations($groupTeachers);

    $bells = bells_data();
    echo json_encode([
        'ok' => true,
        'lastSyncedAt' => date('H:i'),
        'selectedGroup' => $matchedGroup,
        'consultationWeekRange' => $weekRange,
        'groups' => $groups,
        'schedule' => $schedule,
        'groupTeachers' => $groupTeachers,
        'consultations' => $consultations,
        'bellsMonday' => $bells['monday'],
        'bellsRegular' => $bells['regular'],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Временная ошибка при обновлении данных'], JSON_UNESCAPED_UNICODE);
}
