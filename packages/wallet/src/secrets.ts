import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export interface SecretProvider {
  getSecret(reference: string): Promise<string | Uint8Array>;
}
export class EnvironmentSecretProvider implements SecretProvider {
  #allowed: Set<string>;
  #environment: Record<string, string | undefined>;
  constructor(
    names: string[],
    environment: Record<string, string | undefined> = process.env,
  ) {
    this.#allowed = new Set(names);
    this.#environment = environment;
  }
  async getSecret(reference: string): Promise<string> {
    const name = reference.startsWith("env:") ? reference.slice(4) : "";
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !this.#allowed.has(name))
      throw new Error("SECRET_REFERENCE_NOT_ALLOWED");
    const value = this.#environment[name];
    if (!value) throw new Error("SECRET_UNAVAILABLE");
    return value;
  }
}
const execFileAsync = promisify(execFile);
export async function checkPrivateFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536)
    throw new Error("SECRET_FILE_INVALID");
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) throw new Error("SECRET_FILE_PERMISSIONS");
    return;
  }
  const command =
    "$ErrorActionPreference='Stop'; $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($current,'S-1-5-18','S-1-5-32-544'); $acl=Get-Acl -LiteralPath $env:SNIPER_SECRET_PERMISSION_PATH; foreach($rule in $acl.Access){ if($rule.AccessControlType -eq 'Allow' -and (([int]$rule.FileSystemRights -band 1) -ne 0)){ $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($allowed -notcontains $sid){Write-Output 'DENY'; exit 1} } }; Write-Output 'ALLOW'";
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, SNIPER_SECRET_PERMISSION_PATH: path },
        maxBuffer: 1024,
      },
    );
    if (result.stdout.trim() !== "ALLOW")
      throw new Error("SECRET_FILE_PERMISSIONS");
  } catch {
    throw new Error("SECRET_FILE_PERMISSIONS");
  }
}
export class FileSecretProvider implements SecretProvider {
  #root: string;
  #allowed: Set<string>;
  #permissionCheck: (path: string) => Promise<void>;
  constructor(
    root: string,
    references: string[],
    permissionCheck = checkPrivateFile,
  ) {
    this.#root = resolve(root);
    this.#allowed = new Set(references);
    this.#permissionCheck = permissionCheck;
  }
  async getSecret(reference: string): Promise<Uint8Array> {
    if (!reference.startsWith("file:") || !this.#allowed.has(reference))
      throw new Error("SECRET_REFERENCE_NOT_ALLOWED");
    const root = await realpath(this.#root);
    const requested = reference.slice(5);
    const candidate = await realpath(
      isAbsolute(requested) ? requested : resolve(root, requested),
    );
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))
      throw new Error("SECRET_PATH_OUTSIDE_ROOT");
    await this.#permissionCheck(candidate);
    return new Uint8Array(await readFile(candidate));
  }
}
export class CompositeSecretProvider implements SecretProvider {
  #environment: SecretProvider;
  #files?: SecretProvider;
  constructor(environment: SecretProvider, files?: SecretProvider) {
    this.#environment = environment;
    this.#files = files;
  }
  async getSecret(reference: string) {
    if (reference.startsWith("env:"))
      return this.#environment.getSecret(reference);
    if (reference.startsWith("file:") && this.#files)
      return this.#files.getSecret(reference);
    throw new Error("SECRET_REFERENCE_NOT_ALLOWED");
  }
}
