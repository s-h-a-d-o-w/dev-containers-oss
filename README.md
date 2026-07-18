# Dev Containers OSS

Alternative to the proprietary VS Code Dev Containers extension for VSCodium and other VS Code-based IDEs that don't have their own solution. Uses the open-source [Dev Containers CLI](https://github.com/devcontainers/cli) to build/run your container per the full devcontainer spec, then opens your folder inside it either natively or over SSH.

**Note that this uses proposed vscode APIs (just like the official extension), which are subject to change at any time. Which means that any IDE update may break functionality in this extension. (I hope that it will be simple enough to update the API and make adjustments should it ever become necessary but... you should be aware of this risk.)**

## Getting started

Requirements are the same as official, see: https://code.visualstudio.com/docs/devcontainers/containers#_system-requirements

Don't forget to make your SSH key available if you want to commit through the UI: https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials#_using-ssh-keys

## Differences to the official extension

- You have to create the devcontainer config through code, like:

```json
{
  "image": "mcr.microsoft.com/devcontainers/javascript-node"
}
```

- More minimal feature set. But I believe all the necessary basics that make working with dev containers convenient are there.

### SSH fallback

Requires the extension `jeanp413.open-remote-ssh`.

If native dev container functionality isn't available, you will be connected to the containers through SSH. If that's the case for you, please follow the setup instructions here: https://github.com/DDorch/codium-devcontainer (While I have changed a lot of things compared to that project, the basic setting up for SSH connection has stayed the same.)

## Troubleshooting

- Docker permissions: ensure your user can run Docker commands without sudo, and that `docker` is on your `PATH` (the SSH ProxyCommand invokes `docker exec`).

## Acknowledgements

This extension is very loosely based on: https://github.com/DDorch/codium-devcontainer
