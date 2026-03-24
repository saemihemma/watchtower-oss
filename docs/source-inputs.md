# Source Inputs

Watchtower resolves every comparison side to a local filesystem path before snapshotting and execution.

## Supported Formats

Local sources:

- plain relative path such as `./skills`
- plain absolute path such as `/path/to/skills`
- Windows path such as `C:\skills`

GitHub sources:

- `github://owner/repo`
- `github://owner/repo@branch-or-tag`
- `github://owner/repo#commit`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/branch-or-tag`

## Resolution Rules

Local inputs:

- treated as local paths
- resolved to absolute paths before snapshotting

GitHub inputs:

- cloned to a temporary directory under the system temp root
- labeled with `owner/repo` or `owner/repo@ref`
- cleaned up automatically after the run completes

Branch and tag refs:

- resolved with shallow clone plus `--branch`

Commit refs:

- resolved with `git init`, `git fetch --depth 1 origin <sha>`, then `git checkout FETCH_HEAD`

## Operational Notes

- GitHub support depends on `git` being available on `PATH`
- Authentication uses the local git environment already configured on the machine
- No GitHub API tokens or REST calls are used by Watchtower itself
- Local and GitHub sources can be mixed in the same comparison
- Two GitHub sources can be compared directly

## Validation

After resolution, each side must still pass the normal Watchtower validation:

- the root must be reachable
- the root must contain at least one `SKILL.md`
- the snapshotter must be able to copy the tree without escaping the allowlisted root through symlinks

## Replace Restrictions

Replacement is local-only:

- same-library runs may replace one local side with the other when the run is replace-eligible
- GitHub sources are never replacement targets
- cross-library comparisons are never replacement-eligible

## Failure Modes

Common errors:

- missing or invalid GitHub repo
- missing branch, tag, or commit
- missing git credentials for private repos
- no `SKILL.md` files after clone

When GitHub resolution fails, Watchtower surfaces the clone or checkout failure and does not continue into benchmarking.
