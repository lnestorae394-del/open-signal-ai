import type { DocumentStore } from './types.ts';

/**
 * Firestore adapter — NOT IMPLEMENTED YET (planned for Stage 2/3, after the
 * Firebase project exists). It will implement the same `DocumentStore`
 * contract with `firebase-admin/firestore`:
 *
 *   get       → db.collection(c).doc(id).get()
 *   query     → collection.where(...).orderBy(...).limit(...)
 *   create    → docRef.create(data)            (ALREADY_EXISTS on conflict)
 *   set       → docRef.set(data, { merge })
 *   update    → docRef.update(patch)            (NOT_FOUND if missing)
 *   increment → FieldValue.increment(n)
 *   runTransaction → db.runTransaction(tx => …) with tx.get / tx.create / tx.set / tx.update / tx.delete
 *
 * See docs/migration-local-to-firestore.md. Calling this today fails loudly so
 * nothing ever pretends to be connected to Firebase.
 */
export function createFirestoreStore(_projectId: string): DocumentStore {
  throw new Error(
    'Firestore adapter is not implemented yet (Stage 2/3). Use STORAGE_DRIVER=local for development.',
  );
}
