export type ProductInfo = {
  commit: string;
  quality: string;
  version: string;
  release: string;
  applicationName: string;
  serverApplicationName: string;
  serverDataFolderName: string;
  serverDownloadUrlTemplate: string | undefined;
};

export type DevcontainerUpResult = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

export type DevcontainerCustomizations = {
  extensions: string[];
  settings: Record<string, unknown>;
};
