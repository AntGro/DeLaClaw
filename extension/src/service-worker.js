// ===================================================================
// service-worker.js — the extension's durable side (spec §4).
//
// Owns authentication and all Drive I/O. The popup is ephemeral — it
// is destroyed when closed — so it never runs launchWebAuthFlow and
// never holds a token; it talks to this worker by message and the
// worker does the work. (Context menus, step 5, will use the same
// message handlers.)
//
// Message API — every reply is { ok: true, ... } or
// { ok: false, error }:
//   getStatus    → { signedIn, email, confirmed, folder, appUrl, name, isDev }
//   signIn       → { email }            (interactive flow)
//   confirmAccount { email } → { ok }   (persists the account confirmation)
//   signOut      → { ok }
//   getPopupData → { categories, dueHabits, defaultCategoryId, today }
//   quickAdd     { text, priority, categoryId, dueDate } → { id }
//   markHabitDone { habitId } → { nextDue, isFinished }
// ===================================================================

import { VARIANT } from './variant.js';
import {
  getToken,
  fetchAccountEmail,
  getAccount,
  confirmAccount,
  signOut,
  clearToken,
} from './auth.js';
import {
  resolveFolderId,
  listFolderFiles,
  findFile,
  downloadFile,
  writeTable,
  readSchemaVersion,
} from './drive.js';
import {
  buildTodoRow,
  computeMinSortOrder,
  buildCompletionRow,
  recomputeNextDueForDone,
  filterDueHabits,
  resolveDefaultCategory,
  userCategories,
  checkSchemaVersion,
  todayLocalStr,
  normalizeDateOnly,
} from './data.js';

let cachedFolderId = null;

async function folderId(token) {
  if (!cachedFolderId) cachedFolderId = await resolveFolderId(token, VARIANT.folder);
  return cachedFolderId;
}

async function filesInFolder(token) {
  const id = await folderId(token);
  return listFolderFiles(token, id);
}

// Runs fn(token); on a 401, refreshes the token once and retries. A
// second 401 clears the token and reports a signed-out error.
async function withAuthRetry(fn) {
  try {
    return await fn(await getToken());
  } catch (e) {
    if (e?.status !== 401) throw e;
    const token = await getToken({ forceRefresh: true });
    try {
      return await fn(token);
    } catch (e2) {
      if (e2?.status === 401) {
        await clearToken();
        const err = new Error('Your Google sign-in expired. Sign in again.');
        err.code = 'AUTH_REQUIRED';
        throw err;
      }
      throw e2;
    }
  }
}

// The schema-version guard (contracts §6) — runs before every write.
async function guardSchema(token, files) {
  const live = await readSchemaVersion(token, files);
  const refusal = checkSchemaVersion(live, VARIANT.knownSchemaVersion);
  if (refusal) {
    const err = new Error(refusal);
    err.code = 'SCHEMA_TOO_NEW';
    throw err;
  }
}

async function requireConfirmedAccount() {
  const account = await getAccount();
  if (!account?.email || !account.confirmedAt) {
    const err = new Error('Confirm your DeLaClaw account first.');
    err.code = 'NOT_CONFIRMED';
    throw err;
  }
  return account;
}

async function handleGetStatus() {
  const account = await getAccount();
  let signedIn = false;
  try {
    await getToken({ allowInteractive: false });
    signedIn = true;
  } catch (_) {
    signedIn = false;
  }
  return {
    signedIn,
    email: account?.email || null,
    confirmed: !!account?.confirmedAt,
    folder: VARIANT.folder,
    appUrl: VARIANT.appUrl,
    name: VARIANT.name,
    isDev: VARIANT.isDev,
  };
}

async function handleSignIn() {
  const token = await getToken({ interactive: true });
  const email = await fetchAccountEmail(token);
  // Store the email unconfirmed: writes stay blocked until the user
  // confirms this is their DeLaClaw account (spec §4).
  await chrome.storage.local.set({ dlc_account: { email, confirmedAt: null } });
  return { email };
}

async function handleGetPopupData() {
  const data = await withAuthRetry(async (token) => {
    const files = await filesInFolder(token);
    const categoriesFile = findFile(files, 'todo_categories.json');
    const habitsFile = findFile(files, 'habits.json');
    const completionsFile = findFile(files, 'habit_completions.json');
    if (!categoriesFile || !habitsFile || !completionsFile) {
      throw new Error('A DeLaClaw data file is missing. Open the app and sign in there first.');
    }
    const [categories, habits, completions] = await Promise.all([
      downloadFile(token, categoriesFile.id),
      downloadFile(token, habitsFile.id),
      downloadFile(token, completionsFile.id),
    ]);
    const today = todayLocalStr();
    return {
      categories: userCategories(categories),
      defaultCategoryId: resolveDefaultCategory(categories)?.id || null,
      dueHabits: filterDueHabits(habits, completions, today),
      today,
    };
  });
  return data;
}

async function handleQuickAdd({ text, priority, categoryId, dueDate }) {
  await requireConfirmedAccount();
  return withAuthRetry(async (token) => {
    const files = await filesInFolder(token);
    await guardSchema(token, files);
    const todosFile = findFile(files, 'todos.json');
    const categoriesFile = findFile(files, 'todo_categories.json');
    if (!todosFile || !categoriesFile) {
      throw new Error('A DeLaClaw data file is missing. Open the app and sign in there first.');
    }
    const categories = await downloadFile(token, categoriesFile.id);
    const def = resolveDefaultCategory(categories);
    const catId = categoryId || def?.id;
    if (!catId) throw new Error('No TODO category found.');
    const cat = categories.find((c) => String(c.id) === String(catId));
    let insertedId = null;
    await writeTable(token, todosFile, (rows) => {
      const row = buildTodoRow({
        text,
        priority,
        category: cat?.name ?? '',
        categoryId: catId,
        sortOrder: computeMinSortOrder(rows, catId),
        dueDate: dueDate || null,
      });
      insertedId = row.id;
      return [...rows, row];
    }, (rows) => rows.some((r) => r.id === insertedId));
    return { id: insertedId };
  });
}

async function handleMarkHabitDone({ habitId }) {
  await requireConfirmedAccount();
  return withAuthRetry(async (token) => {
    const files = await filesInFolder(token);
    await guardSchema(token, files);
    const habitsFile = findFile(files, 'habits.json');
    const completionsFile = findFile(files, 'habit_completions.json');
    if (!habitsFile || !completionsFile) {
      throw new Error('A DeLaClaw data file is missing. Open the app and sign in there first.');
    }
    const [habits, completions] = await Promise.all([
      downloadFile(token, habitsFile.id),
      downloadFile(token, completionsFile.id),
    ]);
    const habit = habits.find((h) => String(h.id) === String(habitId));
    if (!habit) throw new Error('Habit not found.');
    if (habit.shared_id) throw new Error('Shared habits cannot be completed from the extension.');
    if (habit.is_finished) throw new Error('This habit is finished.');
    if (habit.is_draft) throw new Error('Draft habits cannot be completed from the extension.');
    const nowIso = new Date().toISOString();
    let completionId = null;
    // 1. Insert the completion row.
    await writeTable(token, completionsFile, (rows) => {
      const row = buildCompletionRow(habitId, nowIso);
      completionId = row.id;
      return [...rows, row];
    }, (rows) => rows.some((r) => r.id === completionId));
    // 2. Write back the recomputed next_due (+ is_finished).
    const { next_due, is_finished } = recomputeNextDueForDone(habit, nowIso);
    try {
      await writeTable(token, habitsFile, (rows) => rows.map((h) => (
        String(h.id) === String(habitId)
          ? { ...h, next_due, is_finished, updated_at: nowIso }
          : h
      )), (rows) => {
        const updated = rows.find((h) => String(h.id) === String(habitId));
        return updated
          && normalizeDateOnly(updated.next_due) === normalizeDateOnly(next_due)
          && Number(updated.is_finished || 0) === is_finished;
      });
    } catch (e) {
      // The completion stands; the app recomputes next_due from it on
      // the next load, so the state self-heals. Report it honestly.
      throw new Error(`Completion recorded, but the due date could not be updated (${e.message})`);
    }
    return { nextDue: next_due, isFinished: is_finished };
  });
}

const handlers = {
  getStatus: handleGetStatus,
  signIn: handleSignIn,
  confirmAccount: ({ email }) => confirmAccount(email).then(() => ({})),
  signOut: () => signOut().then(() => ({})),
  getPopupData: handleGetPopupData,
  quickAdd: handleQuickAdd,
  markHabitDone: handleMarkHabitDone,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const handler = handlers[message?.type];
      if (!handler) throw new Error(`Unknown message: ${message?.type}`);
      const data = await handler(message);
      sendResponse({ ok: true, ...data });
    } catch (e) {
      console.warn('[dlc]', message?.type, 'failed:', e);
      sendResponse({ ok: false, error: e.message || String(e), code: e.code || null });
    }
  })();
  return true; // async reply
});
