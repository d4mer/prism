# Move sigma's live bundle out of the git checkout

Audience: the agent that manages sigma.

## Why

Sigma's compose file bind-mounts `./sample-bundle` from inside the git checkout. Every Prism write dirties the working tree (index.md, log.md, new concepts), so `git pull` preflights are never clean and a future update that touches those files would conflict. The bundle is real user data, so this is a careful copy-verify-switch, not a quick edit. Nothing is deleted at any point; the old folder is moved aside as a backup.

Target: `$HOME/prism-data/bundle` (change it if you prefer, but keep it outside the checkout).

**Never print, log or commit the auth token.**

## Prerequisite: pull the compose change

The compose file now reads the host path from `BUNDLE_HOST_PATH` (default `./sample-bundle`, so nothing changes until you set it). This needs the commit that adds `${BUNDLE_HOST_PATH:-./sample-bundle}:/bundle`.

1. The checkout will be dirty with the bundle files (expected). `git pull --ff-only origin main` is fine as long as `git diff --name-only HEAD..origin/main` has no overlap with the dirty paths; check that first, and stop and report if it overlaps.
2. Confirm: `grep BUNDLE_HOST_PATH docker-compose.yml` shows the new line.
3. Do NOT edit docker-compose.yml locally. The switch is done only through `.env`.

## 1. Record the starting state

- Concept count from `memory_status` (expect 4 on 2026-10-27; compare to what you see, do not assume).
- A checksum manifest of the bundle, excluding derived files:
  ```
  cd <checkout>/sample-bundle
  find . -path ./.prism -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > "$HOME/bundle-before.sha256"
  wc -l "$HOME/bundle-before.sha256"
  ```
- A safety archive, kept until the end of this procedure:
  `tar -C <checkout> -czf "$HOME/bundle-pre-move-$(date +%Y%m%d).tgz" sample-bundle`
  (the container runs as root and owns `.prism/`; if tar reports permission errors on `.prism/`, ignore only those, since `.prism/` is derived and rebuildable. Any error on a `.md` file is a stop.)

## 2. Stop the server and copy

Stop writes first so nothing changes mid-copy:

```
docker compose stop prism
mkdir -p "$HOME/prism-data/bundle"
```

Copy with a throwaway container so ownership and modes are preserved without sudo:

```
docker run --rm \
  -v "<checkout>/sample-bundle":/src:ro \
  -v "$HOME/prism-data/bundle":/dst \
  alpine sh -c 'cp -a /src/. /dst/'
```

The destination must have been empty or non-existent beforehand. If it already contained anything, stop and report.

## 3. Verify the copy BEFORE switching

```
cd "$HOME/prism-data/bundle"
find . -path ./.prism -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > "$HOME/bundle-after.sha256"
diff "$HOME/bundle-before.sha256" "$HOME/bundle-after.sha256" && echo IDENTICAL
```

Must print `IDENTICAL`. If not, stop, leave everything as is, and report the diff. The old folder is untouched, so nothing is lost.

## 4. Switch

1. Add to the checkout's `.env` (create the line; do not echo the file, it holds the token):
   `BUNDLE_HOST_PATH=/home/<user>/prism-data/bundle`
   Use the absolute path. Confirm it resolved: `docker compose config | grep 'source:'` must show the new path and not `sample-bundle`.
2. `docker compose up -d`, then wait for healthy.

## 5. Verify the live server

1. Container healthy; `memory_status` concept count equals step 1; conformant.
2. `concept_search` finds a known concept, and the user concept in `fun-facts/` is found by a search for something it contains.
3. Write proof that the new location is the live one: `concept_capture` a throwaway note (title "bundle move check"), then confirm the file exists under `$HOME/prism-data/bundle/inbox/` and that NO new file appeared under `<checkout>/sample-bundle`.
4. `concept_delete` the throwaway note through Prism and confirm the count is back.
5. Optional: `docker compose exec prism node packages/server/bin/prism reindex /bundle` succeeds.

## 6. Clean the checkout (only after step 5 passes)

Move the old bundle aside; do not delete it, and do not use `rm`:

```
mv <checkout>/sample-bundle "$HOME/prism-data/sample-bundle.pre-move-backup"
git checkout -- sample-bundle        # restores the repo's tracked sample files
git status --short                   # must be clean
```

Keep `bundle-pre-move-*.tgz` and the `.pre-move-backup` folder for at least a week, then the user decides when to remove them.

From now on `git pull --ff-only` on sigma is clean, and the bundle lives only in `$HOME/prism-data/bundle`. Back that folder up like any other data.

## Rollback (any failure in steps 3 to 5)

```
docker compose stop prism
# remove the BUNDLE_HOST_PATH line from .env
docker compose up -d
```

The original `<checkout>/sample-bundle` is untouched until step 6, so this restores the previous state exactly. Note that any writes made through the new location between steps 4 and the rollback live only in `$HOME/prism-data/bundle`; mention them in the report.

## Report

Write `docs/sigma-bundle-move-result.md`: starting and ending concept count, pass/fail per step, the final `git status --short`, and where the backups are. No token, and no commits or pushes from sigma.
