export const DEFAULT_WORKFLOW_TEMPLATE = {
  id: "builtin-project-delivery",
  name: "标准项目交付",
  description: "Planner 规划，Coder 并行开发，Tester 分项测试，TesterAll 整体测试。",
  kind: "classic",
  stages: []
};

export function normalizeWorkflowTemplate(input = {}) {
  const name = requiredText(input.name, "template name");
  const description = optionalText(input.description);
  const stages = Array.isArray(input.stages) ? input.stages.map(normalizeStage) : [];
  if (!stages.length) throw new Error("workflow template requires at least one stage");
  const ids = new Set();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`duplicate workflow stage id: ${stage.id}`);
    ids.add(stage.id);
  }
  return { name, description, kind: "linear", stages };
}

export function workflowTemplateDefinition(template) {
  if (!template) return DEFAULT_WORKFLOW_TEMPLATE;
  return typeof template.definition === "object" && template.definition ? template.definition : template;
}

function normalizeStage(stage, index) {
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error(`stage ${index + 1} must be an object`);
  return {
    id: requiredText(stage.id, `stage ${index + 1} id`).replace(/[^A-Za-z0-9_.-]/g, "-"),
    name: optionalText(stage.name) || requiredText(stage.id, `stage ${index + 1} id`),
    role: requiredText(stage.role, `stage ${index + 1} role`),
    mode: stage.mode === "all" ? "all" : "one",
    prompt: requiredText(stage.prompt, `stage ${index + 1} prompt`),
    maxAttempts: Math.min(10, Math.max(1, Number.parseInt(stage.maxAttempts, 10) || 3))
  };
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
