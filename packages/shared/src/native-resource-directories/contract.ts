export interface NativeResourceDirectoryPolicy {
  readonly directoryName: string;
}

export interface NativeResourceDirectoryOptions {
  readonly nativeDirectories?: NativeResourceDirectoryPolicy;
}

export interface NativeResourceDirectoryResolutionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly productDirectoryName?: string;
}
