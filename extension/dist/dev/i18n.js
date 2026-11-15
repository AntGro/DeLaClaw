// ===================================================================
// i18n.js — popup strings (spec §7: all interface text through
// translation keys, EN/FR/ES). The keys are the popup's own — the app's
// resources hold no quick-add / Done / sign-in strings to reuse.
// Language follows the browser UI language; unknown locales fall back
// to English. Diagnostic error details from Drive stay English.
// ===================================================================

export const STRINGS = {
  en: {
    signIn: 'Sign in with Google',
    signInHint: 'Sign in to capture pages and add TODOs to DeLaClaw.',
    signedInAs: 'Signed in as',
    confirmAccount: 'Is this your DeLaClaw account?',
    confirmAccountHint: 'The extension writes into this Google account. Confirm once to enable writing.',
    confirmButton: 'Yes, this is my account',
    quickAdd: 'Quick-add TODO',
    todoPlaceholder: 'Add a TODO…',
    categoryLabel: 'Category',
    generalCategory: 'General',
    priorityLabel: 'Priority',
    dueDateLabel: 'Due date',
    addButton: 'Add',
    savePage: 'Save this page',
    dueHabits: 'Due habits',
    doneButton: 'Done',
    overdue: 'overdue',
    noDueHabits: 'Nothing due.',
    openApp: 'Open DeLaClaw',
    signOut: 'Sign out',
    loading: 'Loading…',
    adding: 'Adding…',
    addedOk: 'TODO added.',
    habitDoneOk: 'Habit done.',
    noFolder: 'No DeLaClaw folder in this account. Open DeLaClaw and sign in there first.',
    writeBlocked: 'Confirm your account above before the extension writes anything.',
  },
  fr: {
    signIn: 'Se connecter avec Google',
    signInHint: 'Connectez-vous pour capturer des pages et ajouter des TODO à DeLaClaw.',
    signedInAs: 'Connecté en tant que',
    confirmAccount: 'Est-ce votre compte DeLaClaw ?',
    confirmAccountHint: 'L’extension écrit dans ce compte Google. Confirmez une fois pour activer l’écriture.',
    confirmButton: 'Oui, c’est mon compte',
    quickAdd: 'Ajout rapide de TODO',
    todoPlaceholder: 'Ajouter un TODO…',
    categoryLabel: 'Catégorie',
    generalCategory: 'Général',
    priorityLabel: 'Priorité',
    dueDateLabel: 'Échéance',
    addButton: 'Ajouter',
    savePage: 'Enregistrer cette page',
    dueHabits: 'Habitudes à faire',
    doneButton: 'Fait',
    overdue: 'en retard',
    noDueHabits: 'Rien à faire.',
    openApp: 'Ouvrir DeLaClaw',
    signOut: 'Se déconnecter',
    loading: 'Chargement…',
    adding: 'Ajout…',
    addedOk: 'TODO ajouté.',
    habitDoneOk: 'Habitude faite.',
    noFolder: 'Aucun dossier DeLaClaw dans ce compte. Ouvrez DeLaClaw et connectez-vous là-bas d’abord.',
    writeBlocked: 'Confirmez votre compte ci-dessus avant que l’extension n’écrive quoi que ce soit.',
  },
  es: {
    signIn: 'Iniciar sesión con Google',
    signInHint: 'Inicia sesión para capturar páginas y añadir TODO a DeLaClaw.',
    signedInAs: 'Sesión iniciada como',
    confirmAccount: '¿Es esta tu cuenta de DeLaClaw?',
    confirmAccountHint: 'La extensión escribe en esta cuenta de Google. Confírmalo una vez para activar la escritura.',
    confirmButton: 'Sí, es mi cuenta',
    quickAdd: 'Añadir TODO rápido',
    todoPlaceholder: 'Añadir un TODO…',
    categoryLabel: 'Categoría',
    generalCategory: 'General',
    priorityLabel: 'Prioridad',
    dueDateLabel: 'Fecha límite',
    addButton: 'Añadir',
    savePage: 'Guardar esta página',
    dueHabits: 'Hábitos pendientes',
    doneButton: 'Hecho',
    overdue: 'atrasado',
    noDueHabits: 'Nada pendiente.',
    openApp: 'Abrir DeLaClaw',
    signOut: 'Cerrar sesión',
    loading: 'Cargando…',
    adding: 'Añadiendo…',
    addedOk: 'TODO añadido.',
    habitDoneOk: 'Hábito hecho.',
    noFolder: 'No hay carpeta DeLaClaw en esta cuenta. Abre DeLaClaw e inicia sesión allí primero.',
    writeBlocked: 'Confirma tu cuenta arriba antes de que la extensión escriba nada.',
  },
};

export function pickLang(uiLang) {
  const prefix = String(uiLang || 'en').slice(0, 2).toLowerCase();
  return STRINGS[prefix] ? prefix : 'en';
}

export function makeT(lang) {
  const table = STRINGS[lang] || STRINGS.en;
  return (key) => table[key] ?? STRINGS.en[key] ?? key;
}
