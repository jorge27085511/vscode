/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { PromptFilesConfig } from '../../common/promptSyntax/config.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { basename, dirname, extUri } from '../../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { PROMPT_SNIPPET_FILE_EXTENSION } from '../../common/promptSyntax/contentProviders/promptContentsProviderBase.js';

/**
 * Returns the top-level root directory of a provided `URI`.
 *
 * ### Examples
 *
 * ```typescript
 * const uri = URI.file('/foo/bar/baz');
 * const root = rootDirname(uri);
 *
 * assert(
 *   extUri.isEqual(root, URI.file('/foo')),
 *	 'The root directory of the provided URI must be `/foo`.',
 * );
 * ```
 */
function rootDirname(uri: URI): URI {
	const parentUri = dirname(uri);

	if (basename(parentUri) === '') {
		return uri;
	}

	return rootDirname(parentUri);
}

/**
 * Resolves a provided `path` relative to the `uri`. The utility is similar to
 * the {@link extUri.resolvePath} function, but handles relative `paths` that
 * overlap with the `uri`. For instance, `/foo/bar` + `bar/baz` => yields
 * `/foo/bar/baz` instead of `/foo/bar/bar/baz`.
 *
 * @returns The resolved `URI`:
 *   - if the provided `path` is an absolute path, it is returned as is
 *   - if the provided `path` is a relative path, it resolves as relative to the `uri`
 *   - if the provided `path` is a relative path and the `uri` ends with the folder that
 *     the `path` starts with, the overlapping part is removed and the `path` is resolved
 *     starting from one level above the original `uri`; e.g., `/foo/bar` + `bar/baz` =>
 *     yields `/foo/bar/baz`.
 */
function resolvePath(uri: URI, path: string): URI {
	const pathUri = URI.parse(path);

	// if `uri` ends with the folder that the `path` starts with,
	// resolve the path starting from one level above the original `uri`
	const uriBasename = basename(uri);
	const pathUriRoot = rootDirname(pathUri);
	if (uriBasename === basename(pathUriRoot)) {
		return resolvePath(
			extUri.resolvePath(uri, '..'),
			path,
		);
	}

	return extUri.resolvePath(uri, path);
}

/**
 * Class to locate prompt instructions files.
 */
export class ChatInstructionsFileLocator {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configService: IConfigurationService,
	) { }

	/**
	 * List all prompt instructions files from the filesystem.
	 *
	 * @param exclude List of `URIs` to exclude from the result.
	 * @returns List of prompt instructions files found in the workspace.
	 */
	public async listFiles(exclude: ReadonlyArray<URI>): Promise<readonly URI[]> {
		// create a set from the list of URIs for convenience
		const excludeSet: Set<string> = new Set();
		for (const excludeUri of exclude) {
			excludeSet.add(excludeUri.path);
		}

		// filter out the excluded paths from the locations list
		const locations = this.getSourceLocations()
			.filter((location) => {
				return !excludeSet.has(location.path);
			});

		return await this.findInstructionFiles(locations, excludeSet);
	}

	/**
	 * Get all possible prompt instructions file locations based on the current
	 * workspace folder structure.
	 *
	 * @returns List of possible prompt instructions file locations.
	 */
	private getSourceLocations(): readonly URI[] {
		const state = this.workspaceService.getWorkbenchState();

		// nothing to do if the workspace is empty
		if (state === WorkbenchState.EMPTY) {
			return [];
		}

		const sourceLocations = PromptFilesConfig.sourceLocations(this.configService);
		const paths = new ResourceSet();

		// otherwise for each folder provided in the configuration, create
		// a URI per each folder in the current workspace
		const { folders } = this.workspaceService.getWorkspace();
		const workspaceRootUri = dirname(folders[0].uri);
		for (const folder of folders) {
			for (const sourceFolderName of sourceLocations) {
				// create the source path as a path relative to the workspace
				// folder, or as an absolute path if the absolute value is provided
				const sourceFolderUri = extUri.resolvePath(folder.uri, sourceFolderName);
				if (!paths.has(sourceFolderUri)) {
					paths.add(sourceFolderUri);
				}

				// if not inside a workspace, we are done
				if (folders.length <= 1) {
					continue;
				}

				// if inside a workspace, consider the specified source location inside
				// the workspace root, to allow users to use some (e.g., `.github/prompts`)
				// folder as a top-level folder in the workspace
				const workspaceFolderUri = extUri.resolvePath(workspaceRootUri, sourceFolderName);
				// if we already have this folder in the list, skip it
				if (paths.has(workspaceFolderUri)) {
					continue;
				}

				// otherwise, if the source location is inside a top-level workspace folder,
				// add it to the list of paths too; this helps to handle the case when a
				// relative path must be resolved from `root` of the workspace
				// TODO: @legomushroom - do we need the custom `resolvePath` utility with this?
				if (workspaceFolderUri.fsPath.startsWith(folder.uri.fsPath)) {
					paths.add(workspaceFolderUri);
				}
			}
		}

		return [...paths];
	}

	/**
	 * Finds all existent prompt instruction files in the provided locations.
	 *
	 * @param locations List of locations to search for prompt instruction files in.
	 * @param exclude Map of `path -> boolean` to exclude from the result.
	 * @returns List of prompt instruction files found in the provided locations.
	 */
	private async findInstructionFiles(
		locations: readonly URI[],
		exclude: ReadonlySet<string>,
	): Promise<readonly URI[]> {
		const results = await this.fileService.resolveAll(
			locations.map((location) => {
				return { resource: location };
			}),
		);

		const files = [];
		for (const result of results) {
			const { stat, success } = result;

			if (!success) {
				continue;
			}

			if (!stat || !stat.children) {
				continue;
			}

			for (const child of stat.children) {
				const { name, resource, isDirectory } = child;

				if (isDirectory) {
					continue;
				}

				if (!name.endsWith(PROMPT_SNIPPET_FILE_EXTENSION)) {
					continue;
				}

				if (exclude.has(resource.path)) {
					continue;
				}

				files.push(resource);
			}
		}

		return files;
	}
}
