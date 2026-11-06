(Only changes that are likely meaningful for users are listed here.)

## Unreleased

- Honor `shutdownAction` when closing a connected window, with a grace period for reloads and protection for other connected windows. Stop containers without removing them.

## v1.4.0

- Add option for disabling creation/use of lockfiles.

## v1.3.0

- Support reopening in a devcontainer while connected to a WSL remote.

## v1.2.8

- Extension install problem addressed in 1.2.3 was temporary. Individual extension installation is now used as a fallback going forward.

## v1.2.3

- Fix extension install errors (503) by installing extensions individually. Seems like Open VSX now either blocks or can't handle batch extension installation.

## v1.2.1

- Stop and remove outdated vscode servers in the container.

## v1.2.0

- Added support for automatically forwarding ports.
