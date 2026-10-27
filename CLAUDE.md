# Kalai Art House: working rules

- `main` = TEST site (art.pranixtechno.com for now), `production` = LIVE site. Work on `main`, then push the same commit to both:
  `git pull --rebase && git push origin main && git push origin main:production`.
- **Before every push, run the regression checks** and push only if they all pass:
  `python3 tests/ui/regress.py` (builds a stubbed copy of the site from `tests/ui/build.py`, runs Playwright checks).
  Install the hook once per clone so it runs automatically:
  `printf '#!/bin/sh\npython3 tests/ui/regress.py || exit 1\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push`
- **Every bug found (in testing or reported by Anis) gets a check in `tests/ui/regress.py`** in the same commit as the fix,
  so it cannot come back. Name the check after what the person would see.
- Stub data lives in `tests/ui/stub/` (Amplify replaced; data in localStorage `stubdb`). Extend the stub when a new
  mutation or query is needed for a check.
