import { loadWalletDefinitions, LocalWalletManager } from "./local";
import {
  CompositeSecretProvider,
  EnvironmentSecretProvider,
  FileSecretProvider,
} from "./secrets";
export async function createLocalWalletManager(options: {
  configPath?: string;
  secretFilesRoot?: string;
  environment?: Record<string, string | undefined>;
}) {
  const definitions = await loadWalletDefinitions(options.configPath);
  const references = definitions.flatMap((wallet) =>
    wallet.secretRef ? [wallet.secretRef] : [],
  );
  const environment = new EnvironmentSecretProvider(
    references
      .filter((ref) => ref.startsWith("env:"))
      .map((ref) => ref.slice(4)),
    options.environment ?? process.env,
  );
  const files = options.secretFilesRoot
    ? new FileSecretProvider(
        options.secretFilesRoot,
        references.filter((ref) => ref.startsWith("file:")),
      )
    : undefined;
  return new LocalWalletManager(
    definitions,
    new CompositeSecretProvider(environment, files),
  );
}
