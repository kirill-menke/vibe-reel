#!/usr/bin/env python3
"""Are the documented timing constants pinned? Stryker has no number-literal
mutator, so it never changes `const STALL_FAIL_MS = 30000` — this does.

    stryker/constants.py [--project tv|phone]

Each case below nudges one constant CLAUDE.md documents (both ways), applies it
to a copy of the repo under run/stryker/constants/, runs the player test files
and expects a failure. PINNED = some test failed; LOOSE = the suite passed with
the constant changed (a gap). Never touches the working tree's src/.
"""
import os
import subprocess
import sys

FILE = 'src/lib/player.svelte.js'
TESTS = ['test/shared/player.stall.test.js', 'test/shared/player.slowlink.test.js', 'test/shared/player.stopped.test.js',
         'test/shared/player.upnext.test.js', 'test/shared/player.skips.test.js', 'test/shared/player.scrub.test.js',
         'test/tv/picture.test.js']   # TV-only: the picture-service cases are LOOSE under --project phone by design
CASES = [
    # (what CLAUDE.md says, exact source text, replacements)
    ('stall ring after 2 s', 'const STALL_SPIN_MS = 2000;', ['const STALL_SPIN_MS = 2500;', 'const STALL_SPIN_MS = 1500;']),
    ('stall card after 30 s', 'const STALL_FAIL_MS = 30000;', ['const STALL_FAIL_MS = 33000;', 'const STALL_FAIL_MS = 27000;']),
    ('never-started card after 60 s', 'const START_FAIL_MS = 60000;', ['const START_FAIL_MS = 66000;', 'const START_FAIL_MS = 54000;']),
    ('buffered range ≤ 30 s behind counts', 'b.end(i) >= t - 30 &&', ['b.end(i) >= t - 25 &&', 'b.end(i) >= t - 35 &&']),
    ('slow-link hint after 8 s', 'const SLOW_MIN_WALL_MS = 8000;', ['const SLOW_MIN_WALL_MS = 9000;', 'const SLOW_MIN_WALL_MS = 7000;']),
    ('slow-link below 85 %', 'const SLOW_RATIO = 0.85;', ['const SLOW_RATIO = 0.9;', 'const SLOW_RATIO = 0.8;']),
    ('Stopped retry 3/10/30 s', 'const STOP_RETRY_MS = [3000, 10000, 30000];',
     ['const STOP_RETRY_MS = [4000, 10000, 30000];', 'const STOP_RETRY_MS = [3000, 12000, 30000];',
      'const STOP_RETRY_MS = [3000, 10000, 40000];', 'const STOP_RETRY_MS = [3000, 10000];',
      'const STOP_RETRY_MS = [3000, 10000, 30000, 60000];']),
    ('Up Next 10 s countdown', 'const UPNEXT_COUNT = 10;', ['const UPNEXT_COUNT = 12;', 'const UPNEXT_COUNT = 8;']),
    ('Up Next last 20 s without credits', 'const UPNEXT_TAIL = 20;', ['const UPNEXT_TAIL = 25;', 'const UPNEXT_TAIL = 15;']),
    ('scrub commits after 900 ms', 'const SCRUB_COMMIT = 900;', ['const SCRUB_COMMIT = 1000;', 'const SCRUB_COMMIT = 800;']),
    ('seekTarget held ~900 ms', '    seekTarget = null;\n  }, 900);', ['    seekTarget = null;\n  }, 1000);', '    seekTarget = null;\n  }, 800);']),
    ('picture service 6 s deadline', 'const PIC_TIMEOUT = 6000;', ['const PIC_TIMEOUT = 7000;', 'const PIC_TIMEOUT = 5000;']),
    ('picture set: 4.5 s, then re-read /modes', 'setTimeout(res, 4500)', ['setTimeout(res, 5000)', 'setTimeout(res, 4000)']),
]

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
copy = os.path.join(repo, 'run', 'stryker', 'constants')
project = sys.argv[sys.argv.index('--project') + 1] if '--project' in sys.argv else 'tv'

os.makedirs(copy, exist_ok=True)
subprocess.run(['rsync', '-a', '--delete', '--exclude', 'node_modules', '--exclude', 'run', '--exclude', 'dist',
                '--exclude', 'out', '--exclude', 'backend', '--exclude', 'stryker', '--exclude', '.git',
                '--exclude', 'phone/dist', '--exclude', '.env*', repo + '/', copy + '/'], check=True)
link = os.path.join(copy, 'node_modules')
if not os.path.islink(link):
    os.symlink(os.path.join(repo, 'node_modules'), link)

path = os.path.join(copy, FILE)
src = open(path).read()
loose = 0
try:
    for what, old, news in CASES:
        if src.count(old) != 1:
            print(f'MISSING  {what}: {old!r} not found exactly once — update stryker/constants.py')
            loose += 1
            continue
        for new in news:
            open(path, 'w').write(src.replace(old, new))
            p = subprocess.run(['npx', 'vitest', 'run', '--project', project, *TESTS], cwd=copy,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ok = p.returncode != 0
            loose += not ok
            print(('PINNED   ' if ok else 'LOOSE    ') + f'{what}: {new}', flush=True)
finally:
    open(path, 'w').write(src)
print('all pinned' if not loose else f'{loose} loose')
sys.exit(1 if loose else 0)
