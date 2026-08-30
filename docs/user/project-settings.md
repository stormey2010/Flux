# Customize a project icon

Flux selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

Flux supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Project agent prompt (`AGENTS.md`)

Coding agents load `AGENTS.md` from the project root as standing instructions for that checkout.

To create or edit it:

1. Right-click a project in the sidebar and choose **Create Prompt**, or open **Settings** →
   **Projects** → the project → **Agent prompt**.
2. Edit the full markdown, then **Save**.

**Create Prompt** writes a starter `AGENTS.md` when the file is missing, then opens the editor.
If the file already exists, it opens the existing prompt without overwriting it.
