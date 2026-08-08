import type { CatalogModel } from "../types.ts";
import type { Registry } from "../adapters/registry.ts";

export class ModelCatalog {
  private models: CatalogModel[] = [];
  private readonly created = Math.floor(Date.now() / 1000);

  constructor(private readonly registry: Registry) {}

  async bootstrap(opts?: { onlyAvailable?: boolean }): Promise<void> {
    const ids =
      opts?.onlyAvailable === false
        ? this.registry.listToolIds()
        : await this.registry.detectAvailable();

    // If nothing detected, still advertise enabled tools so clients can try.
    const toolIds = ids.length ? ids : this.registry.listToolIds();
    this.models = toolIds.map((toolId) => {
      const spec = this.registry.getSpec(toolId);
      return {
        id: `prompt-${toolId}`,
        object: "model" as const,
        created: this.created,
        owned_by: `prompt-${toolId}`,
        metadata: {
          toolId,
          name: toolId,
          description: spec?.description,
        },
      };
    });
  }

  list(): CatalogModel[] {
    return this.models;
  }
}
