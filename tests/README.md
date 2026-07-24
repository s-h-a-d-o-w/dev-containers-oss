Tests may fail locally with:

```
Worker teardown timeout of 180000ms exceeded.

Failed worker ran 1 test:
...
  1 error was not a part of any test, see above for details
[ELIFECYCLE] Command failed with exit code 1.
```

Codium may even get stuck at "Opening Remote...". I was iterating on tests for many hours just fine and then suddenly, I stopped being able to connect to the dev container. Only while running these tests.

If you know fixes, please contribute or let me know!

# macOS

Don't bother. These are the runtimes as of writing:

```
Ubuntu: ~2 min.
Windows: ~6 min.
macOS: failed after ~21 min. (During rebuilding. I didn't care to figure out how long it would take.)
```

Also: arm64 runners can't be used because they don't support nested virtualization. So if you want to punish yourself, you have to specifically use runners tagged `intel`.
