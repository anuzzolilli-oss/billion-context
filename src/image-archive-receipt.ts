import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";

export interface ImageArchiveReceipt {
    ordinal: number;
    mediaType: string;
    sha256: string;
    ref: string;
    note: string;
}

export function imagePayloadHash(base64: string): string {
    return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

export function sameImage(a: CoreMessage, b: CoreMessage): boolean {
    const left = a as BiliMessage, right = b as BiliMessage;
    if (!left.imagePart && !right.imagePart) return true;
    if (!left.imagePart || !right.imagePart) return false;
    if (left.imageBase64 !== undefined || right.imageBase64 !== undefined) {
        return typeof left.imageBase64 === "string" && typeof right.imageBase64 === "string"
            && left.imageMediaType === right.imageMediaType && imagePayloadHash(left.imageBase64) === imagePayloadHash(right.imageBase64);
    }
    return JSON.stringify(left.rawOpenaiContent) === JSON.stringify(right.rawOpenaiContent);
}

export function projectImageArchives(messages: readonly CoreMessage[], batches: readonly (readonly ImageArchiveReceipt[])[]): CoreMessage[] | undefined {
    let expected = [...messages];
    for (const batch of batches) {
        const positions = expected.flatMap((m, index) => (m as BiliMessage).imagePart ? [index] : []);
        const claimed = new Set<number>();
        for (const receipt of batch) {
            if (!Number.isInteger(receipt.ordinal) || receipt.ordinal < 0 || receipt.ordinal >= positions.length || claimed.has(receipt.ordinal)) return undefined;
            if (!/^m\d+$/.test(receipt.ref) || !/^image\/[a-zA-Z0-9.+-]+$/.test(receipt.mediaType)) return undefined;
            const index = positions[receipt.ordinal];
            const image = expected[index] as BiliMessage;
            if (typeof image.imageBase64 !== "string" || image.imageMediaType !== receipt.mediaType || imagePayloadHash(image.imageBase64) !== receipt.sha256) return undefined;
            if (!receipt.note.startsWith(`[image: ${receipt.mediaType.slice(6)} `) || !receipt.note.endsWith(` ${receipt.ref} omitted for size limit]`)) return undefined;
            expected[index] = { id: image.id, role: image.role, contentType: "text", text: receipt.note };
            claimed.add(receipt.ordinal);
        }
    }
    return expected;
}
