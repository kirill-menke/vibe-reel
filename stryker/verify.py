#!/usr/bin/env python3
"""Re-check Stryker mutants one at a time, outside Stryker.

    stryker/verify.py run/stryker/report.json Timeout,Survived [--project tv|phone|tv,phone] test/shared/x.test.js ...

Why: Stryker counts a Timeout as "detected", and on a loaded machine the
*static* mutants (module-level constants: Sets, regexes, tables) time out
because each one re-runs every test that imported the module. Several of those
were really survivors. This applies each mutant (status in the given list) to
a copy of the repo under run/stryker/verify/, runs only the given test files
with Vitest and prints KILLED / SURVIVED per mutant (a run over VERIFY_TIMEOUT,
default 180 s, counts as killed and is marked [timeout]). Two runs at once need
separate copies: VERIFY_DIR=run/stryker/verify-b. It also sidesteps lazily
cached module state (e.g. tracks.js LANG_WORDS), which Stryker's mutant
switching can't see: the copy is evaluated fresh with the mutant in place.

Never touches src/ of the working tree (only the copy).
"""
import json
import os
import signal
import subprocess
import sys

TIMEOUT = int(os.environ.get('VERIFY_TIMEOUT', '180'))   # seconds per mutant
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
copy = os.environ.get('VERIFY_DIR') or os.path.join(repo, 'run', 'stryker', 'verify')   # one dir per parallel run

args = sys.argv[1:]
project = 'tv'
if '--project' in args:
    i = args.index('--project')
    project = args[i + 1]
    del args[i:i + 2]
if len(args) < 3:
    sys.exit(__doc__)
report, statuses, tests = args[0], args[1].split(','), args[2:]

os.makedirs(copy, exist_ok=True)
subprocess.run(['rsync', '-a', '--delete', '--exclude', 'node_modules', '--exclude', 'run', '--exclude', 'dist',
                '--exclude', 'out', '--exclude', 'backend', '--exclude', 'stryker', '--exclude', '.git',
                '--exclude', 'phone/dist', '--exclude', '.env*', repo + '/', copy + '/'], check=True)
link = os.path.join(copy, 'node_modules')
if not os.path.islink(link):
    os.symlink(os.path.join(repo, 'node_modules'), link)

r = json.load(open(report))
results = []
for fn, f in r['files'].items():
    src = f['source']
    offs = [0]
    for line in src.split('\n'):
        offs.append(offs[-1] + len(line) + 1)
    path = os.path.join(copy, fn)
    try:
        for m in sorted(f['mutants'], key=lambda m: (m['location']['start']['line'], m['location']['start']['column'])):
            if m['status'] not in statuses:
                continue
            s, e = m['location']['start'], m['location']['end']
            a = offs[s['line'] - 1] + s['column'] - 1
            b = offs[e['line'] - 1] + e['column'] - 1
            with open(path, 'w') as out:
                out.write(src[:a] + m['replacement'] + src[b:])
            projs = [a for x in project.split(',') for a in ('--project', x)]
            p = subprocess.Popen(['npx', 'vitest', 'run', *projs, *tests], cwd=copy,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                killed, how = p.wait(timeout=TIMEOUT) != 0, ''
            except subprocess.TimeoutExpired:
                # an endless loop (e.g. a mutated `while` condition): detected, but say so
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                killed, how = True, ' [timeout]'
            label = f"{fn}:{s['line']}:{s['column']} {src[a:b][:50]!r} -> {m['replacement'][:50]!r} ({m['status']}){how}"
            results.append(killed)
            print(('KILLED   ' if killed else 'SURVIVED ') + label, flush=True)
    finally:
        with open(path, 'w') as out:
            out.write(src)
print(f'killed {sum(results)} of {len(results)}')
