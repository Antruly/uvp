import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE_REGISTRY_INDEX_URL,
  TEMPLATE_REGISTRY_CONFIG_SCHEMA,
  readTemplateRegistryConfig,
  resetTemplateRegistryConfig,
  resolveTemplateRegistryIndexUrl,
  writeTemplateRegistryConfig,
} from "./TemplateRegistry.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "uvp-registry-config-"));
  roots.push(root);
  return root;
};

describe("the registry index configuration", () => {
  it("defaults to the public index when no flag, environment, or file answers", async () => {
    const home = await temporaryRoot();
    const resolved = await resolveTemplateRegistryIndexUrl(undefined, {}, home);
    expect(resolved.url).toBe(DEFAULT_TEMPLATE_REGISTRY_INDEX_URL);
    expect(resolved.source).toBe("default");
    expect(resolved.configPath).toBe(path.join(home, ".uvp", "registry.json"));
  });

  it("resolves flag over environment over the saved file over the default", async () => {
    const home = await temporaryRoot();
    const configPath = path.join(home, "registry.json");
    await writeTemplateRegistryConfig("https://file.example/index.json", configPath);
    const env = {
      UVP_REGISTRY_CONFIG: configPath,
      UVP_TEMPLATE_REGISTRY_URL: "https://env.example/index.json",
    };

    expect(
      (await resolveTemplateRegistryIndexUrl("https://flag.example/index.json", env, home)).source,
    ).toBe("flag");
    expect((await resolveTemplateRegistryIndexUrl(undefined, env, home)).source).toBe(
      "environment",
    );
    expect(
      (await resolveTemplateRegistryIndexUrl(undefined, { UVP_REGISTRY_CONFIG: configPath }, home))
        .source,
    ).toBe("config");
  });

  it("round-trips a saved URL and resets it", async () => {
    const home = await temporaryRoot();
    const configPath = path.join(home, ".uvp", "registry.json");
    await writeTemplateRegistryConfig("https://mirror.example/index.json", configPath);

    expect(await readTemplateRegistryConfig(configPath)).toEqual({
      schema: TEMPLATE_REGISTRY_CONFIG_SCHEMA,
      indexUrl: "https://mirror.example/index.json",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      schema: TEMPLATE_REGISTRY_CONFIG_SCHEMA,
      index_url: "https://mirror.example/index.json",
    });

    await resetTemplateRegistryConfig(configPath);
    expect(await readTemplateRegistryConfig(configPath)).toBeUndefined();
  });

  it("refuses a non-http URL and an invalid saved schema", async () => {
    const home = await temporaryRoot();
    const configPath = path.join(home, "registry.json");
    await expect(writeTemplateRegistryConfig("file:///tmp/index.json", configPath)).rejects.toThrow(
      /not an http\(s\) URL/u,
    );

    await writeTemplateRegistryConfig("https://mirror.example/index.json", configPath);
    const invalid = path.join(home, "invalid.json");
    await writeFile(
      invalid,
      '{"schema":"not-uvp","index_url":"https://mirror.example/index.json"}',
    );
    await expect(readTemplateRegistryConfig(invalid)).rejects.toThrow(/uvp\.registry-config\/1/u);
    await expect(
      readTemplateRegistryConfig(path.join(home, "missing.json")),
    ).resolves.toBeUndefined();
  });
});
