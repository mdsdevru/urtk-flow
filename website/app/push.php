<?php
declare(strict_types=1);

if (!defined('URTK_API_LIB')) {
    define('URTK_API_LIB', true);
}
require_once __DIR__ . '/api.php';

const PUSH_RATE_LIMIT_MAX = 20;
const PUSH_RATE_LIMIT_WINDOW = 60;
const PUSH_VAPID_SUBJECT = 'mailto:admin@mdsdev.ru';
const PUSH_MAX_SUBSCRIPTIONS = 2500;

function b64url_encode(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64url_decode(string $data): ?string {
    $data = trim($data);
    if ($data === '' || !preg_match('/^[A-Za-z0-9\-_]+={0,2}$/', $data)) {
        return null;
    }
    $pad = strlen($data) % 4;
    if ($pad > 0) {
        $data .= str_repeat('=', 4 - $pad);
    }
    $decoded = base64_decode(strtr($data, '-_', '+/'), true);
    return is_string($decoded) ? $decoded : null;
}

function push_is_allowed_endpoint(string $url): bool {
    if ($url === '' || strlen($url) > 1024 || preg_match('/[\x00-\x1F\x7F\s]/', $url)) {
        return false;
    }
    $p = parse_url($url);
    if (!is_array($p)) {
        return false;
    }
    if (strtolower((string)($p['scheme'] ?? '')) !== 'https') {
        return false;
    }
    if (isset($p['user']) || isset($p['pass']) || isset($p['port'])) {
        return false;
    }
    $host = strtolower((string)($p['host'] ?? ''));
    if ($host === '' || filter_var($host, FILTER_VALIDATE_IP)) {
        return false;
    }

    // Strict allowlist of official browser Web Push services (blocks SSRF)
    $exactHosts = [
        'fcm.googleapis.com',
        'android.googleapis.com',
        'updates.push.services.mozilla.com',
        'updates-autopush.stage.mozaws.net',
    ];
    if (in_array($host, $exactHosts, true)) {
        return true;
    }
    $suffixes = [
        '.push.apple.com',
        '.notify.windows.com',
        '.push.samsungosp.com',
        '.push.services.mozilla.com',
    ];
    foreach ($suffixes as $suf) {
        if (str_ends_with($host, $suf) && strlen($host) > strlen($suf)) {
            return true;
        }
    }
    return false;
}

function push_extract_uncompressed_pub($keyResource): ?string {
    $details = openssl_pkey_get_details($keyResource);
    if (!is_array($details) || !isset($details['ec']['x'], $details['ec']['y'])) {
        return null;
    }
    $x = str_pad((string)$details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
    $y = str_pad((string)$details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
    if (strlen($x) !== 32 || strlen($y) !== 32) {
        return null;
    }
    return "\x04" . $x . $y;
}

function push_load_or_create_vapid(): array {
    $file = cache_dir() . '/vapid.json';
    if (is_file($file) && !is_link($file)) {
        $raw = @file_get_contents($file);
        if (is_string($raw) && $raw !== '') {
            $data = json_decode($raw, true);
            if (is_array($data) && !empty($data['publicKey']) && !empty($data['privatePem'])) {
                return $data;
            }
        }
    }

    $lock = @fopen(cache_dir() . '/vapid.lock', 'c');
    if ($lock !== false) {
        @flock($lock, LOCK_EX);
    }
    try {
        if (is_file($file) && !is_link($file)) {
            $raw = @file_get_contents($file);
            if (is_string($raw) && $raw !== '') {
                $data = json_decode($raw, true);
                if (is_array($data) && !empty($data['publicKey']) && !empty($data['privatePem'])) {
                    return $data;
                }
            }
        }

        $res = openssl_pkey_new([
            'curve_name' => 'prime256v1',
            'private_key_type' => OPENSSL_KEYTYPE_EC,
        ]);
        if ($res === false) {
            throw new RuntimeException('OpenSSL EC key generation failed');
        }
        $pubRaw = push_extract_uncompressed_pub($res);
        if ($pubRaw === null) {
            throw new RuntimeException('Failed to extract EC public key');
        }
        $privPem = '';
        if (!openssl_pkey_export($res, $privPem)) {
            throw new RuntimeException('Failed to export EC private key');
        }

        $data = [
            'publicKey' => b64url_encode($pubRaw),
            'privatePem' => $privPem,
            'createdAt' => date('c'),
        ];
        $tmp = @tempnam(cache_dir(), 'vapid_');
        if ($tmp !== false) {
            file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES), LOCK_EX);
            @chmod($tmp, 0600);
            @rename($tmp, $file);
        }
        return $data;
    } finally {
        if ($lock !== false) {
            @flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

function push_der_sig_to_raw(string $der): ?string {
    $len = strlen($der);
    if ($len < 8 || ord($der[0]) !== 0x30) {
        return null;
    }
    $pos = 2;
    if ((ord($der[1]) & 0x80) !== 0) {
        $lenBytes = ord($der[1]) & 0x7F;
        $pos = 2 + $lenBytes;
    }
    if ($pos >= $len || ord($der[$pos]) !== 0x02) {
        return null;
    }
    $rLen = ord($der[$pos + 1]);
    $r = substr($der, $pos + 2, $rLen);
    $pos = $pos + 2 + $rLen;
    if ($pos >= $len || ord($der[$pos]) !== 0x02) {
        return null;
    }
    $sLen = ord($der[$pos + 1]);
    $s = substr($der, $pos + 2, $sLen);

    $r = ltrim($r, "\x00");
    $s = ltrim($s, "\x00");
    if (strlen($r) > 32 || strlen($s) > 32) {
        return null;
    }
    return str_pad($r, 32, "\x00", STR_PAD_LEFT) . str_pad($s, 32, "\x00", STR_PAD_LEFT);
}

function push_build_vapid_jwt(string $endpoint, array $vapid): string {
    $p = parse_url($endpoint);
    $aud = ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '');
    $header = b64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256'], JSON_UNESCAPED_SLASHES));
    $claims = b64url_encode(json_encode([
        'aud' => $aud,
        'exp' => time() + 43200,
        'sub' => PUSH_VAPID_SUBJECT,
    ], JSON_UNESCAPED_SLASHES));

    $signingInput = $header . '.' . $claims;
    $privKey = openssl_pkey_get_private($vapid['privatePem']);
    if ($privKey === false) {
        throw new RuntimeException('Invalid VAPID private key');
    }
    $derSig = '';
    if (!openssl_sign($signingInput, $derSig, $privKey, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('VAPID signing failed');
    }
    $rawSig = push_der_sig_to_raw($derSig);
    if ($rawSig === null) {
        throw new RuntimeException('DER signature conversion failed');
    }
    return $signingInput . '.' . b64url_encode($rawSig);
}

function push_raw_pub_to_pem(string $rawPub): string {
    // Fixed ASN.1 SubjectPublicKeyInfo header for uncompressed EC prime256v1 public key
    $spkiPrefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    $der = $spkiPrefix . $rawPub;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

function push_encrypt_aes128gcm(string $payload, string $uaPubB64, string $authB64): ?string {
    $uaPub = b64url_decode($uaPubB64);
    $authSecret = b64url_decode($authB64);
    if ($uaPub === null || strlen($uaPub) !== 65 || ord($uaPub[0]) !== 0x04) {
        return null;
    }
    if ($authSecret === null || strlen($authSecret) !== 16) {
        return null;
    }

    $localKey = openssl_pkey_new([
        'curve_name' => 'prime256v1',
        'private_key_type' => OPENSSL_KEYTYPE_EC,
    ]);
    if ($localKey === false) {
        return null;
    }
    $asPub = push_extract_uncompressed_pub($localKey);
    if ($asPub === null || strlen($asPub) !== 65) {
        return null;
    }

    $uaPem = push_raw_pub_to_pem($uaPub);
    $uaKeyRes = openssl_pkey_get_public($uaPem);
    if ($uaKeyRes === false) {
        return null;
    }

    $ecdh = openssl_pkey_derive($uaKeyRes, $localKey, 32);
    if (!is_string($ecdh) || $ecdh === '') {
        return null;
    }
    $ecdh = str_pad($ecdh, 32, "\x00", STR_PAD_LEFT);

    $salt = random_bytes(16);

    // RFC 8291 key schedule
    $prkKey = hash_hmac('sha256', $ecdh, $authSecret, true);
    $keyInfo = "WebPush: info\x00" . $uaPub . $asPub;
    $ikm = substr(hash_hmac('sha256', $keyInfo . "\x01", $prkKey, true), 0, 32);

    $prk = hash_hmac('sha256', $ikm, $salt, true);
    $cek = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\x00\x01", $prk, true), 0, 16);
    $nonce = substr(hash_hmac('sha256', "Content-Encoding: nonce\x00\x01", $prk, true), 0, 12);

    $plaintext = $payload . "\x02"; // RFC 8188 final record delimiter
    $tag = '';
    $cipher = openssl_encrypt($plaintext, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if (!is_string($cipher) || strlen($tag) !== 16) {
        return null;
    }

    // RFC 8188 aes128gcm content coding header: salt(16) || rs(4) || idlen(1) || keyid(65)
    $header = $salt . pack('N', 4096) . chr(65) . $asPub;
    return $header . $cipher . $tag;
}

function push_send_notification(array $sub, array $message, array $vapid): array {
    $endpoint = (string)($sub['endpoint'] ?? '');
    if (!push_is_allowed_endpoint($endpoint)) {
        return ['ok' => false, 'status' => 0, 'gone' => true];
    }
    $jsonPayload = json_encode($message, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (!is_string($jsonPayload)) {
        return ['ok' => false, 'status' => 0, 'gone' => false];
    }
    $body = push_encrypt_aes128gcm($jsonPayload, (string)($sub['p256dh'] ?? ''), (string)($sub['auth'] ?? ''));
    if ($body === null) {
        return ['ok' => false, 'status' => 0, 'gone' => true];
    }

    $jwt = push_build_vapid_jwt($endpoint, $vapid);
    $headers = [
        'Content-Type: application/octet-stream',
        'Content-Encoding: aes128gcm',
        'Content-Length: ' . strlen($body),
        'TTL: 3600',
        'Urgency: high',
        'Authorization: vapid t=' . $jwt . ', k=' . $vapid['publicKey'],
    ];

    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'ok' => $code >= 200 && $code < 300,
        'status' => $code,
        'gone' => ($code === 404 || $code === 410),
    ];
}

function push_subs_path(): string {
    return cache_dir() . '/push_subs.json';
}

function push_with_subs(callable $mutator) {
    $path = push_subs_path();
    $fp = @fopen($path, 'c+');
    if ($fp === false) {
        throw new RuntimeException('Cannot open push subscriptions store');
    }
    @chmod($path, 0600);
    if (!@flock($fp, LOCK_EX)) {
        fclose($fp);
        throw new RuntimeException('Cannot lock push subscriptions store');
    }
    try {
        $raw = stream_get_contents($fp);
        $subs = is_string($raw) && $raw !== '' ? json_decode($raw, true) : [];
        if (!is_array($subs)) {
            $subs = [];
        }
        $dirty = false;
        $result = $mutator($subs, $dirty);
        if ($dirty) {
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($subs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            fflush($fp);
        }
        return $result;
    } finally {
        @flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function push_schedule_fingerprint(array $schedule): array {
    $map = [];
    foreach ($schedule as $day) {
        $date = (string)($day['date'] ?? '');
        if ($date === '') continue;
        $lessons = [];
        foreach (($day['lessons'] ?? []) as $l) {
            $lessons[] = [
                'pair' => (int)($l['pairNumber'] ?? 0),
                'subject' => trim((string)($l['subject'] ?? '')),
                'teacher' => trim((string)($l['teacher'] ?? '')),
                'room' => trim((string)($l['room'] ?? '')),
                'time' => trim((string)($l['startTime'] ?? '')),
            ];
        }
        usort($lessons, static fn($a, $b) => [$a['pair'], $a['subject'], $a['room']] <=> [$b['pair'], $b['subject'], $b['room']]);
        $map[$date] = [
            'weekday' => (string)($day['weekday'] ?? ''),
            'lessons' => $lessons,
        ];
    }
    ksort($map);
    return $map;
}

function push_diff_schedules(array $prevDays, array $nextDays): array {
    $prev = push_schedule_fingerprint($prevDays);
    $next = push_schedule_fingerprint($nextDays);
    $changes = [];

    $todayStr = (new DateTimeImmutable('now', new DateTimeZone('Asia/Yekaterinburg')))->setTime(0, 0, 0);

    $allDates = array_values(array_unique(array_merge(array_keys($prev), array_keys($next))));
    foreach ($allDates as $date) {
        $dt = parse_ru_date($date, $todayStr);
        if ($dt !== null && $dt < $todayStr) {
            continue; // Ignore changes on days that have already passed
        }
        $pDay = $prev[$date] ?? null;
        $nDay = $next[$date] ?? null;
        if ($pDay === null && $nDay !== null && !empty($nDay['lessons'])) {
            $shortDate = substr($date, 0, 5);
            $changes[] = "{$shortDate}: появилось расписание (" . count($nDay['lessons']) . ' пар)';
            continue;
        }
        if ($pDay !== null && $nDay === null) {
            continue; // Week rolled over
        }
        if ($pDay !== null && $nDay !== null && json_encode($pDay['lessons']) !== json_encode($nDay['lessons'])) {
            $shortDate = substr($date, 0, 5);
            $pCount = count($pDay['lessons']);
            $nCount = count($nDay['lessons']);
            if ($pCount !== $nCount) {
                $diff = $nCount - $pCount;
                $sign = $diff > 0 ? "+{$diff}" : (string)$diff;
                $changes[] = "{$shortDate}: изменились пары ({$sign})";
            } else {
                // Find specific changed pair
                $detail = null;
                foreach ($nDay['lessons'] as $idx => $nl) {
                    $pl = $pDay['lessons'][$idx] ?? null;
                    if ($pl === null) continue;
                    if ($pl['room'] !== $nl['room'] && $pl['subject'] === $nl['subject']) {
                        $detail = "{$shortDate}: {$nl['pair']} пара — ауд. {$pl['room']} → {$nl['room']}";
                        break;
                    }
                    if ($pl['subject'] !== $nl['subject'] || $pl['teacher'] !== $nl['teacher']) {
                        $detail = "{$shortDate}: замена на {$nl['pair']} паре ({$nl['subject']})";
                        break;
                    }
                }
                $changes[] = $detail ?? "{$shortDate}: обновились пары/аудитории";
            }
        }
    }

    return $changes;
}

function push_enforce_rate_limit(): void {
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $rlFile = cache_dir() . '/rl_push_' . hash('sha256', $ip) . '.json';
    $now = time();
    $fp = @fopen($rlFile, 'c+');
    if ($fp === false) return;
    if (@flock($fp, LOCK_EX)) {
        $raw = stream_get_contents($fp);
        $hits = is_string($raw) && $raw !== '' ? json_decode($raw, true) : [];
        if (!is_array($hits)) $hits = [];
        $cutoff = $now - PUSH_RATE_LIMIT_WINDOW;
        $hits = array_values(array_filter($hits, static fn($ts) => is_int($ts) && $ts >= $cutoff));
        if (count($hits) >= PUSH_RATE_LIMIT_MAX) {
            @flock($fp, LOCK_UN);
            fclose($fp);
            http_response_code(429);
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
}

if (!defined('URTK_PUSH_LIB')) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');

    try {
        push_enforce_rate_limit();
        $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

        if ($method === 'GET') {
            $action = (string)($_GET['action'] ?? 'vapid');
            if ($action !== 'vapid') {
                http_response_code(400);
                echo json_encode(['ok' => false, 'error' => 'Invalid action'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            $vapid = push_load_or_create_vapid();
            echo json_encode(['ok' => true, 'publicKey' => $vapid['publicKey']], JSON_UNESCAPED_SLASHES);
            exit;
        }

        if ($method !== 'POST') {
            http_response_code(405);
            header('Allow: GET, POST');
            echo json_encode(['ok' => false, 'error' => 'Method Not Allowed'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $rawBody = file_get_contents('php://input', false, null, 0, 8192);
        $input = is_string($rawBody) ? json_decode($rawBody, true) : null;
        if (!is_array($input)) {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Некорректный JSON'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $action = (string)($input['action'] ?? '');
        $subIn = is_array($input['subscription'] ?? null) ? $input['subscription'] : [];
        $endpoint = trim((string)($subIn['endpoint'] ?? ($input['endpoint'] ?? '')));

        if (!push_is_allowed_endpoint($endpoint)) {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Неподдерживаемый Push-сервис'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $subId = hash('sha256', $endpoint);

        if ($action === 'unsubscribe') {
            push_with_subs(static function (array &$subs, bool &$dirty) use ($subId) {
                if (isset($subs[$subId])) {
                    unset($subs[$subId]);
                    $dirty = true;
                }
            });
            echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $keys = is_array($subIn['keys'] ?? null) ? $subIn['keys'] : [];
        $p256dh = trim((string)($keys['p256dh'] ?? ''));
        $auth = trim((string)($keys['auth'] ?? ''));
        $pubBytes = b64url_decode($p256dh);
        $authBytes = b64url_decode($auth);
        if ($pubBytes === null || strlen($pubBytes) !== 65 || ord($pubBytes[0]) !== 0x04 || $authBytes === null || strlen($authBytes) !== 16) {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Некорректные ключи подписки'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if ($action === 'subscribe') {
            $rawGroup = trim((string)($input['group'] ?? ''));
            $groups = fetch_groups();
            $matchedGroup = '';
            $matchedId = '';
            foreach ($groups as $g) {
                if (mb_strtolower($g['name'], 'UTF-8') === mb_strtolower($rawGroup, 'UTF-8')) {
                    $matchedGroup = $g['name'];
                    $matchedId = $g['id'];
                    break;
                }
            }
            if ($matchedGroup === '' || $matchedId === '') {
                http_response_code(400);
                echo json_encode(['ok' => false, 'error' => 'Сначала выберите учебную группу'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            push_with_subs(static function (array &$subs, bool &$dirty) use ($subId, $endpoint, $p256dh, $auth, $matchedGroup, $matchedId) {
                if (!isset($subs[$subId]) && count($subs) >= PUSH_MAX_SUBSCRIPTIONS) {
                    // Evict oldest subscription if global cap reached
                    uasort($subs, static fn($a, $b) => ($a['updatedAt'] ?? 0) <=> ($b['updatedAt'] ?? 0));
                    array_shift($subs);
                }
                $subs[$subId] = [
                    'endpoint' => $endpoint,
                    'p256dh' => $p256dh,
                    'auth' => $auth,
                    'group' => $matchedGroup,
                    'groupId' => $matchedId,
                    'updatedAt' => time(),
                    'lastTestAt' => $subs[$subId]['lastTestAt'] ?? 0,
                ];
                $dirty = true;
            });

            // Prime baseline snapshot if none exists yet so first real Akademiks change triggers cleanly
            $snapFile = cache_dir() . '/sched_snap_' . hash('sha256', $matchedId) . '.json';
            if (!is_file($snapFile)) {
                [$sched] = fetch_group_schedule($matchedId);
                if (!empty($sched)) {
                    @file_put_contents($snapFile, json_encode($sched, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
                    @chmod($snapFile, 0600);
                }
            }

            echo json_encode(['ok' => true, 'group' => $matchedGroup], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if ($action === 'test') {
            $subRecord = push_with_subs(static function (array &$subs, bool &$dirty) use ($subId) {
                if (!isset($subs[$subId])) {
                    return null;
                }
                $lastTest = (int)($subs[$subId]['lastTestAt'] ?? 0);
                if ((time() - $lastTest) < 15) {
                    return 'cooldown';
                }
                $subs[$subId]['lastTestAt'] = time();
                $dirty = true;
                return $subs[$subId];
            });

            if ($subRecord === null) {
                http_response_code(404);
                echo json_encode(['ok' => false, 'error' => 'Подписка не найдена — включите уведомления заново'], JSON_UNESCAPED_UNICODE);
                exit;
            }
            if ($subRecord === 'cooldown') {
                http_response_code(429);
                echo json_encode(['ok' => false, 'error' => 'Подождите 15 секунд перед следующей проверкой'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            $vapid = push_load_or_create_vapid();
            $res = push_send_notification($subRecord, [
                'title' => 'URTK Flow · ' . $subRecord['group'],
                'body' => 'Уведомления работают! Как только расписание в Академиксе изменится, вы получите пуш.',
                'url' => '/app/',
                'tag' => 'urtk-flow-test',
            ], $vapid);

            if ($res['gone']) {
                push_with_subs(static function (array &$subs, bool &$dirty) use ($subId) {
                    unset($subs[$subId]);
                    $dirty = true;
                });
            }

            if (!$res['ok']) {
                http_response_code(502);
                echo json_encode(['ok' => false, 'error' => 'Push-сервис отклонил доставку (HTTP ' . $res['status'] . ')'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
            exit;
        }

        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Неизвестное действие'], JSON_UNESCAPED_UNICODE);
    } catch (Throwable) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'Ошибка сервера уведомлений'], JSON_UNESCAPED_UNICODE);
    }
}
