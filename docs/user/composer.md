# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Flux keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Queued messages

Send a message while the agent is working to add it to the queue above the composer.
Queued messages run in order after the current turn finishes. They appear in the
conversation when sent.

Choose **Steer** on a queued message to submit it to the active turn. Use the message
menu to edit its text, then **Save** or **Cancel**. Editing preserves attachments and
your composer draft. Delete a queued message with the trash button, or drag its handle
to change the order. The handle also supports keyboard reordering.

Stopping the agent pauses the queue. Choose **Resume** to continue. If sending fails,
the queue waits for **Retry**; it does not skip to later messages.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, Flux hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Flux opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

On web and desktop, turn on **Show usage in chat** in **Settings → General** to show the current
provider's remaining session and weekly limits next to the chat box. The meter stays hidden until
the thread has sent its first message and only appears when the provider exposes usable quota data.
