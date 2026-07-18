// Trimmed copy of the VS Code `resolvers` proposed API (declaration merging into the
// stable `vscode` module). Only the members this extension actually uses are declared.
// This is the same mechanism the official Dev Containers / Remote-SSH extensions use to
// place the editor inside a remote (here: a container) without going through SSH.

declare module "vscode" {
  export interface RemoteAuthorityResolverContext {
    resolveAttempt: number;
  }

  export class ResolvedAuthority {
    readonly host: string;
    readonly port: number;
    readonly connectionToken: string | undefined;

    constructor(host: string, port: number, connectionToken?: string);
  }

  export interface ManagedMessagePassing {
    onDidReceiveMessage: Event<Uint8Array>;
    onDidClose: Event<Error | undefined>;
    onDidEnd: Event<void>;

    send(data: Uint8Array): void;
    end(): void;
    drain?(): Thenable<void>;
  }

  export class ManagedResolvedAuthority {
    readonly makeConnection: () => Thenable<ManagedMessagePassing>;
    readonly connectionToken: string | undefined;

    constructor(makeConnection: () => Thenable<ManagedMessagePassing>, connectionToken?: string);
  }

  export interface ResolvedOptions {
    extensionHostEnv?: { [key: string]: string | null };
    isTrusted?: boolean;
  }

  export type ResolverResult = (ResolvedAuthority | ManagedResolvedAuthority) & ResolvedOptions;

  export enum RemoteAuthorityResolverErrorCode {
    Unknown = "Unknown",
    NotAvailable = "NotAvailable",
    TemporarilyNotAvailable = "TemporarilyNotAvailable",
    NoResolverFound = "NoResolverFound"
  }

  export class RemoteAuthorityResolverError extends Error {
    static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError;
    static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError;

    constructor(message?: string, code?: RemoteAuthorityResolverErrorCode, detail?: any);
  }

  export interface RemoteAuthorityResolver {
    resolve(
      authority: string,
      context: RemoteAuthorityResolverContext
    ): ResolverResult | Thenable<ResolverResult>;
    getCanonicalURI?(uri: Uri): ProviderResult<Uri>;
  }

  export interface ResourceLabelFormatter {
    scheme: string;
    authority?: string;
    formatting: ResourceLabelFormatting;
  }

  export interface ResourceLabelFormatting {
    label: string;
    separator: "/" | "\\" | "";
    tildify?: boolean;
    normalizeDriveLetter?: boolean;
    workspaceSuffix?: string;
    workspaceTooltip?: string;
    authorityPrefix?: string;
    stripPathStartingSeparator?: boolean;
  }

  export namespace workspace {
    export function registerRemoteAuthorityResolver(
      authorityPrefix: string,
      resolver: RemoteAuthorityResolver
    ): Disposable;

    export function registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable;
  }
}
