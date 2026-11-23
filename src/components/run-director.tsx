"use client";

import { createContext, useContext } from "react";

/**
 * Where the app's prompt rewrite runs, for runs started from inside a control
 * rather than from the form — the Create bar on a picture, which writes a
 * reference with Text to Image's director. The studio holds the choice (see
 * `directorEngine` there) and provides it here, so a control several layers
 * down sends the same director a run from the form would.
 */
export interface RunDirector {
  /** The local model's id when the rewrite runs on the ComfyUI machine. */
  localDirector?: string;
  /** The gateway model, when it runs there. */
  rewriteModel?: string;
}

const RunDirectorContext = createContext<RunDirector>({});

export const RunDirectorProvider = RunDirectorContext.Provider;

export function useRunDirector(): RunDirector {
  return useContext(RunDirectorContext);
}
