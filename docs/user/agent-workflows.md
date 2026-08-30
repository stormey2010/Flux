# Agents & Workflows

Flux can give the coordinator a reusable catalog of specialist roles. Open
**Settings → Agents & Workflows** to enable delegation, edit the coordinator
instructions, and manage profiles such as Planner, Frontend, Backend, Testing,
and Reviewer.

Each profile can define its role description, detailed instructions, preferred
model, up to five backup models, parallelism, timeout, and whether nested
delegation is allowed. Leave the preferred model set to **Use coordinator
model** to inherit the model running the main task.

The saved catalog is included in provider prompts. Providers with native
collaboration support can use their own subagent/workflow tools; other
providers can still follow the role guidance, but provider-native child-model
selection and fallback behavior may vary.
