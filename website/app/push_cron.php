<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}

define('URTK_API_LIB', true);
define('URTK_PUSH_LIB', true);
require_once __DIR__ . '/push.php';

$lockFp = @fopen(cache_dir() . '/push_cron.lock', 'c');
if ($lockFp === false || !@flock($lockFp, LOCK_EX | LOCK_NB)) {
    exit(0);
}

try {
    $subs = push_with_subs(static fn(array &$s, bool &$dirty) => $s);
    if (empty($subs)) {
        exit(0);
    }

    // Group active subscribers by role + targetId (student group or teacher)
    $byTarget = [];
    foreach ($subs as $subId => $sub) {
        $role = ((string)($sub['role'] ?? 'student')) === 'teacher' ? 'teacher' : 'student';
        $tid = (string)($sub['groupId'] ?? '');
        $tName = (string)($sub['group'] ?? '');
        if ($tid === '' || $tName === '') continue;
        $key = $role . ':' . $tid;
        if (!isset($byTarget[$key])) {
            $byTarget[$key] = ['role' => $role, 'id' => $tid, 'name' => $tName, 'subs' => []];
        }
        $byTarget[$key]['subs'][$subId] = $sub;
    }

    if (empty($byTarget)) {
        exit(0);
    }

    $vapid = push_load_or_create_vapid();
    $goneIds = [];
    $sentCount = 0;

    foreach ($byTarget as $key => $bucket) {
        [$freshSched] = $bucket['role'] === 'teacher'
            ? fetch_teacher_schedule($bucket['id'])
            : fetch_group_schedule($bucket['id']);
        if (empty($freshSched)) {
            continue;
        }

        $snapFile = cache_dir() . '/sched_snap_' . hash('sha256', $key) . '.json';
        $prevSched = null;
        if (is_file($snapFile) && !is_link($snapFile)) {
            $raw = @file_get_contents($snapFile);
            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $prevSched = $decoded;
                }
            }
        }

        // Always update saved snapshot atomically
        $tmp = @tempnam(cache_dir(), 'snap_');
        if ($tmp !== false) {
            file_put_contents($tmp, json_encode($freshSched, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
            @chmod($tmp, 0600);
            @rename($tmp, $snapFile);
        }

        if ($prevSched === null) {
            continue; // Baseline saved, wait for next real change
        }

        $changes = push_diff_schedules($prevSched, $freshSched);
        if (empty($changes)) {
            continue;
        }

        $summary = implode(' · ', array_slice($changes, 0, 2));
        if (count($changes) > 2) {
            $summary .= ' (+' . (count($changes) - 2) . ')';
        }

        $payload = [
            'title' => 'Изменилось расписание · ' . $bucket['name'],
            'body' => $summary,
            'url' => '/app/',
            'tag' => 'urtk-sched-' . $bucket['id'],
        ];

        foreach ($bucket['subs'] as $subId => $sub) {
            $res = push_send_notification($sub, $payload, $vapid);
            if ($res['ok']) {
                $sentCount++;
            } elseif ($res['gone']) {
                $goneIds[] = $subId;
            }
        }
    }

    if (!empty($goneIds)) {
        push_with_subs(static function (array &$s, bool &$dirty) use ($goneIds) {
            foreach ($goneIds as $id) {
                if (isset($s[$id])) {
                    unset($s[$id]);
                    $dirty = true;
                }
            }
        });
    }

    echo sprintf("[%s] targets=%d sent=%d pruned=%d\n", date('Y-m-d H:i:s'), count($byTarget), $sentCount, count($goneIds));
} finally {
    @flock($lockFp, LOCK_UN);
    fclose($lockFp);
}
