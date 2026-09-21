#!/usr/bin/env bash
#
# Remove the data tables from this repository's history.
#
# Until v1.3.0 the Parquet tables were committed here. From v2.0.0 the tables
# live behind the API, where browsing is capped at 100 rows a request -- but a
# cap means nothing while `git clone` still hands over the whole corpus. This
# rewrites every commit so the files were never there.
#
# It does NOT push. The rewrite is local, reversible from the backup it makes,
# and prints the push command for you to run once you have looked at the
# result.
#
# Be clear about what this can and cannot do. It stops the repository
# distributing the data from here on. It does not reach anyone who has already
# cloned it, and GitHub keeps rewritten commits reachable by their SHA until
# they are garbage-collected -- ask GitHub Support to purge them if that
# matters to you.
#
#     bash scripts/scrub_history.sh
#
set -euo pipefail

PATHS=(
  "data/tweets.parquet"
  "data/leaders.parquet"
  "data/sentiment.parquet"
  "data/tweets.csv"
  "data/leaders.csv"
  "data/sentiment.csv"
)

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes. Commit or stash them first:"
  git status --short
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
stamp=$(date -u +%Y%m%d-%H%M%S)
bundle="$(cd .. && pwd)/esmd-pre-scrub-$stamp.bundle"

echo "About to rewrite every commit on '$branch' to remove:"
for p in "${PATHS[@]}"; do
  n=$(git log --oneline --all -- "$p" | wc -l | tr -d ' ')
  size=$(git cat-file -s "$(git rev-parse "HEAD:$p" 2>/dev/null)" 2>/dev/null || echo 0)
  printf '  %-28s %s commits, %s bytes at HEAD\n' "$p" "$n" "$size"
done
echo
echo "Before: $(git rev-list --count HEAD) commits, $(du -sh .git | cut -f1) of git objects."
echo
echo "A full backup is written first, as a bundle OUTSIDE this repository:"
echo "  $bundle"
echo
echo "It has to be outside: the rewrite touches every ref in here, so a backup"
echo "branch would be rewritten along with the rest and would not be a backup."
echo
read -r -p 'Type "rewrite" to continue: ' answer
[ "$answer" = "rewrite" ] || { echo "nothing done"; exit 1; }

git bundle create "$bundle" --all
git bundle verify "$bundle" >/dev/null
echo "backup written and verified: $bundle"
echo

if command -v git-filter-repo >/dev/null 2>&1; then
  echo "using git-filter-repo"
  args=()
  for p in "${PATHS[@]}"; do args+=(--path "$p"); done
  # --invert-paths keeps everything except those; --force because this is not
  # a fresh clone. The backup above is what makes that safe.
  git filter-repo --force --invert-paths "${args[@]}"
  # filter-repo drops the remote on purpose; put it back so the push below works.
  git remote get-url origin >/dev/null 2>&1 || {
    echo
    echo "git-filter-repo removed the 'origin' remote, as it always does."
    echo "Add it back with:"
    echo "  git remote add origin git@github.com:juangomezcruces/Executive-Social-Media-Database.git"
  }
else
  echo "git-filter-repo is not installed; falling back to git filter-branch."
  echo "(filter-repo is faster and is what GitHub recommends: pip install git-filter-repo)"
  echo
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
    --index-filter "git rm --cached --ignore-unmatch ${PATHS[*]}" \
    --prune-empty --tag-name-filter cat -- --all
  # filter-branch leaves the originals reachable; drop them so the repack works.
  git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin
fi

git reflog expire --expire=now --all
git gc --prune=now --aggressive >/dev/null 2>&1 || git gc --prune=now

echo
echo "After: $(git rev-list --count HEAD) commits, $(du -sh .git | cut -f1) of git objects."
echo
echo "Check the result before pushing:"
echo "  git log --oneline --all -- data/tweets.parquet    # must print nothing"
echo "  git log --oneline | head"
echo "  ls data/                                          # your working files are untouched"
echo
echo "Then publish the rewrite:"
echo "  git push --force-with-lease origin $branch"
echo "  git push --force origin --tags"
echo
echo "If anything looks wrong, the whole repository as it was is in the bundle."
echo "Recover the old history with either:"
echo "  git clone $bundle recovered"
echo "  git fetch $bundle 'refs/heads/*:refs/heads/pre-scrub/*'"
echo
echo "Keep that bundle somewhere safe and OFF any public host: it still"
echo "contains the tables."
