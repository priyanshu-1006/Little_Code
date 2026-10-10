# Saved conversations

The Agent panel saves prompts, answer text, mode, provider/model, timestamps and completion status in native workspace storage. Choose a saved chat with the selector, start a separate conversation with **New chat**, or clear the current project's history with the delete control and native confirmation. The same project and profile must be reopened to restore its chats.

The previous implementation retained runtime events only in memory. Closing the window discarded that display history. New conversations now persist before generation begins; streamed answers are saved in short batches and terminal states are flushed. A run interrupted by a restart restores as an interrupted, read-only card. Older conversations from before this implementation cannot be recovered from memory after the process has closed.

Storage is bounded to 20 chats, 30 turns per chat and 512 KiB per project. Prompt and answer previews are capped at 8,000 and 32,000 characters. Older entries are pruned with a visible notice. Likely secrets and private reasoning are removed before persistence. Chat storage uses the application's local profile; it is not a cloud synchronization service.

Only the selected chat's four most recent completed prompt/answer pairs may enter a follow-up request, capped at 3,000 characters and included in the request budget. Previous conversation is labelled untrusted recollection: current source must be inspected again when needed. Failed, cancelled, interrupted and running turns do not supply that context.

Saved cards carry no executable tool bindings, command approvals or restore grants. Loading or switching a chat cannot resume or replay actions. Checkpoints and reviewed project memory remain separate features. Save failures are visible; corrupt records are ignored rather than replayed.
