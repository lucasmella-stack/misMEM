import { useState } from "react";
import { toast } from "sonner";
import { actions, type ForgetChallenge } from "@/api";
import { errorMessage } from "@/lib/errors";
import type { Selection } from "@/lib/selection";

/**
 * The confirmations of the memory view: unconsolidating is one step, forgetting needs a token
 * the server issues together with the impact, so the two live apart from the rendering.
 */
export function useMemoryActions(memoryId: string | undefined, onChanged: (next?: Selection | null) => void) {
  const [confirm, setConfirm] = useState<"unconsolidate" | "forget" | null>(null);
  const [challenge, setChallenge] = useState<ForgetChallenge>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  // Forgetting takes two steps (viewer-actions.ts): the server says what would be lost and gives
  // the confirming token; without it nothing is deleted. The dialog shows that impact, not one
  // computed here.
  const askForget = async () => {
    if (!memoryId) return;
    setConfirm("forget");
    setChallenge(undefined);
    setActionError(undefined);
    try {
      setChallenge(await actions.forgetMemoryChallenge(memoryId));
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const runAction = async (kind: "unconsolidate" | "forget") => {
    if (!memoryId) return;
    setBusy(true);
    setActionError(undefined);
    try {
      if (kind === "unconsolidate") {
        const out = await actions.unconsolidate(memoryId);
        setConfirm(null);
        toast.success(
          out.episodes_released === 1
            ? "Consolidación deshecha: el episodio vuelve a estar pendiente."
            : `Consolidación deshecha: ${out.episodes_released} episodios vuelven a estar pendientes.`,
        );
      } else {
        if (!challenge) return;
        const out = await actions.forgetMemory(memoryId, challenge.confirm_token);
        setConfirm(null);
        toast.success(
          out.episodes_deleted === 1
            ? "Memoria olvidada con su episodio."
            : `Memoria olvidada con ${out.episodes_deleted} episodios.`,
        );
      }
      onChanged(null);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message);
      toast.error(`No se pudo: ${message}`);
      // The token was spent on the attempt: without a new one, the next click would not delete either.
      if (kind === "forget") {
        setChallenge(undefined);
        actions.forgetMemoryChallenge(memoryId).then(setChallenge, () => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    setConfirm(null);
    setChallenge(undefined);
    setActionError(undefined);
  };

  return {
    confirm,
    challenge,
    busy,
    actionError,
    openUnconsolidate: () => setConfirm("unconsolidate"),
    askForget,
    runAction,
    dismiss,
  };
}
