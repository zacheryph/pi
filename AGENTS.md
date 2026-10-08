# Repository instructions

## Git commits

Always disable GPG signing explicitly for every commit:

```bash
git -c commit.gpgsign=false commit ...
```

Do not change global Git signing settings.
