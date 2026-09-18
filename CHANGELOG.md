(Only changes that are likely meaningful for users are listed here.)

## v1.2.8

- Extension install problem addressed in 1.2.3 was temporary. Individual extension installation is now used as a fallback going forward.

## v1.2.3

- Fix extension install errors (503) by installing extensions individually. Seems like Open VSX now either blocks or can't handle batch extension installation.

## v1.2.1

- Stop and remove outdated vscode servers in the container.

## v1.2.0

- Added support for automatically forwarding ports.
