#!/usr/bin/env python3
"""A copy of the board, kept on this machine.

  npm run backup                      (python3 tools/backup_board.py [--keep N] [--dir DIR])

Nothing ages off the board now, so everything anyone ever pinned lives in one D1 database, and
D1's own Time Travel only winds back thirty days. This exports the live database with wrangler
(which must be signed in: `npx wrangler login`) to a dated .sql file: the notes, the posters and
their pictures, the voicemail, what is torn down and what was moved. The `kv` table is left out:
it is the aircraft feed's last copy, rewritten every half minute.

The files go outside the repository, in ~/liminal-bench-backups (or --dir, or BOARD_BACKUP_DIR),
readable by this user only: a backup holds the voicemail and the salted address hashes, so it
never belongs in the repository, which is public, or anywhere else that is. The newest --keep
(60) are kept and older ones removed. D1 does not answer requests while it exports; on a
database this size that is a moment.

To put one back (docs/deploy.md, section 8): into an empty database,
  npx wrangler d1 execute liminal-bench --remote --file=FILE.sql
"""
import argparse, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = 'liminal-bench'
TABLES = ['notes', 'posters', 'voicemail', 'torn', 'placed']   # everything but kv
NAME = re.compile(r'^board-\d{8}-\d{6}\.sql$')


def main():
    ap = argparse.ArgumentParser(description='export the live board to a dated .sql file')
    ap.add_argument('--dir', default=os.environ.get('BOARD_BACKUP_DIR') or os.path.expanduser('~/liminal-bench-backups'))
    ap.add_argument('--keep', type=int, default=60, help='how many backups to keep (default 60)')
    a = ap.parse_args()

    os.makedirs(a.dir, mode=0o700, exist_ok=True)
    out = os.path.join(a.dir, time.strftime('board-%Y%m%d-%H%M%S.sql'))
    part = out + '.part'   # a failed export never leaves something that looks like a backup
    cmd = ['npx', 'wrangler', 'd1', 'export', DB, '--remote', '--output', part]
    for t in TABLES: cmd += ['--table', t]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(part):
        if os.path.exists(part): os.remove(part)
        sys.exit('the export failed:\n' + (r.stderr or r.stdout).strip()[-2000:])

    # what is in it: every table must be there, and the rows are counted for the report
    rows = dict.fromkeys(TABLES, 0); made = set()
    with open(part, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.match(r'\s*INSERT INTO ["`\[]?(\w+)', line)
            if m and m.group(1) in rows: rows[m.group(1)] += 1; continue
            m = re.match(r'\s*CREATE TABLE (?:IF NOT EXISTS )?["`\[]?(\w+)', line)
            if m: made.add(m.group(1))
    missing = [t for t in TABLES if t not in made]
    if missing:
        os.remove(part)
        sys.exit('the export has no table ' + ', '.join(missing) + ': not kept')
    os.chmod(part, 0o600); os.replace(part, out)

    old = sorted(f for f in os.listdir(a.dir) if NAME.match(f))[:-max(1, a.keep)]
    for f in old: os.remove(os.path.join(a.dir, f))

    print(f'{out}  ({os.path.getsize(out) / 1024:.0f} KB)')
    print('  ' + ', '.join(f'{t} {rows[t]}' for t in TABLES))
    print(f'  {len([f for f in os.listdir(a.dir) if NAME.match(f)])} backups kept' + (f', {len(old)} old removed' if old else ''))


if __name__ == '__main__':
    main()
