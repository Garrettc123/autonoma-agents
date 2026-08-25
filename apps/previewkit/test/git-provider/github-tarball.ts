import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pack as packTar } from "tar-fs";

/**
 * Builds a gzipped tarball shaped exactly like GitHub's `/tarball` response: every entry nested under a single
 * top-level `owner-repo-<sha>/` directory. `files` maps repo-relative paths to contents.
 *
 * Returns a buffer rather than a stream so a caller can also feed a TRUNCATED copy of it - the shape of a download
 * that dies mid-body.
 */
export async function makeGitHubTarballBuffer(wrapperDir: string, files: Record<string, string>): Promise<Buffer> {
    const source = await mkdtemp(path.join(tmpdir(), "pk-tarball-src-"));
    try {
        for (const [relPath, content] of Object.entries(files)) {
            const full = path.join(source, wrapperDir, relPath);
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, content);
        }
        // tar-fs pack() emits entries relative to `source`, i.e. prefixed with the wrapper dir - the same
        // single-top-level-directory shape GitHub produces.
        const chunks: Buffer[] = [];
        for await (const chunk of packTar(source).pipe(createGzip())) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    } finally {
        await rm(source, { recursive: true, force: true });
    }
}
