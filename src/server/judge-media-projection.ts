import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, openaiToCore, type BiliMessage } from "acp-kernel/wire";
import { applyImageRescalePass } from "../image-rescale.js";
import { systemToUser } from "../util.js";

/** Independent expected view: never read the actual outbound request here. */
export async function projectOpenaiJudgeMedia(
    messages: readonly BiliMessage[],
    ctx: Parameters<typeof applyImageRescalePass>[1],
    renderTailStart?: number,
) {
    const canonical = (view: BiliMessage[]) => openaiToCore({ messages: coreToOpenai(systemToUser(view, isRenderedSummaryMessage)) }).msgs;
    if (renderTailStart === undefined || !Number.isInteger(renderTailStart) || renderTailStart < 0 || renderTailStart > messages.length) {
        return { messages: canonical(await applyImageRescalePass([...messages], ctx)), renderTailStart: undefined };
    }
    // Rescaling is message-local. Split BEFORE it can expand a prefix image
    // into image + annotation; then map the seam through the wire codec too.
    const prefix = await applyImageRescalePass(messages.slice(0, renderTailStart), ctx);
    const tail = await applyImageRescalePass(messages.slice(renderTailStart), ctx);
    const projected = canonical([...prefix, ...tail]);
    const projectedPrefix = canonical(prefix);
    let boundary = 0;
    while (boundary < projectedPrefix.length && boundary < projected.length
        && JSON.stringify(projectedPrefix[boundary]) === JSON.stringify(projected[boundary])) boundary++;
    // A wire message may merge across the seam (e.g. adjacent assistants).
    // Include that whole message so its live suffix can never go unchecked.
    return { messages: projected, renderTailStart: boundary };
}
