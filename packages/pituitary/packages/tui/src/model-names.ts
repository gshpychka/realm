/** A model as Pi describes it: upstream owns its name, and its provider and id address it. */
export interface NamedModel {
  provider: string;
  id: string;
  name?: string;
}

/** The name the operator reads for a model, as Pi's registry gives it; a model with none reads as its id. */
export function modelName(model: NamedModel): string {
  return model.name?.trim() || model.id;
}

const named = (model: NamedModel) => modelName(model) !== model.id;

/** Where a model comes from, as a row beside its name shows it: the provider, and the id when the name hides it. */
export function modelSource(model: NamedModel): string {
  return named(model) ? `${model.provider}/${model.id}` : model.provider;
}

/** A model as a notice names it: `provider/id`, led by its name when it has its own. */
export function modelTitle(model: NamedModel): string {
  const source = `${model.provider}/${model.id}`;
  return named(model) ? `${modelName(model)} · ${source}` : source;
}
