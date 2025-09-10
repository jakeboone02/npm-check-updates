import glob, { type Options as GlobOptions } from 'fast-glob'
import fs from 'fs/promises'
import path from 'path'
import untildify from 'untildify'
import { parse } from 'yaml'
import { Index } from '../types/IndexType'
import { Options } from '../types/Options'
import { PackageFile } from '../types/PackageFile'
import { PackageInfo } from '../types/PackageInfo'
import { VersionSpec } from '../types/VersionSpec'
import findPackage from './findPackage'
import loadPackageInfoFromFile from './loadPackageInfoFromFile'
import programError from './programError'

type PnpmWorkspaces = string[] | { packages: string[]; catalogs?: Index<Index<VersionSpec>> }

const globOptions: GlobOptions = {
  ignore: ['**/node_modules/**'],
}

/** Reads, parses, and resolves workspaces from a pnpm-workspace file at the same path as the package file. */
const readPnpmWorkspaces = async (pkgPath: string): Promise<PnpmWorkspaces | null> => {
  const pnpmWorkspacesPath = path.join(path.dirname(pkgPath), 'pnpm-workspace.yaml')
  let pnpmWorkspaceFile: string
  try {
    pnpmWorkspaceFile = await fs.readFile(pnpmWorkspacesPath, 'utf-8')
  } catch {
    return null
  }
  return parse(pnpmWorkspaceFile) as PnpmWorkspaces
}

/** Gets catalog dependencies from both pnpm-workspace.yaml and package.json files, separated by catalog name. */
const readCatalogDependencies = async (options: Options, pkgPath: string): Promise<Index<Index<VersionSpec>> | null> => {
  const catalogDependencies: Index<Index<VersionSpec>> = {}

  // Read from pnpm-workspace.yaml if the package manager is pnpm
  if (options.packageManager === 'pnpm') {
    const pnpmWorkspaces = await readPnpmWorkspaces(pkgPath)
    if (pnpmWorkspaces && !Array.isArray(pnpmWorkspaces) && pnpmWorkspaces.catalogs) {
      Object.assign(catalogDependencies, pnpmWorkspaces.catalogs)
    }
  }

  // Read from package.json (for Bun and modern pnpm)
  let packageData: PackageFile & {
    catalog?: Index<VersionSpec>
    catalogs?: Index<Index<VersionSpec>>
    workspaces?: string[] | { packages: string[]; catalog?: Index<VersionSpec>; catalogs?: Index<Index<VersionSpec>> }
  }

  try {
    packageData = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }

  // Add default catalog if it exists
  if (packageData.catalog) {
    catalogDependencies.default = { ...catalogDependencies.default, ...packageData.catalog }
  }
  // Add named catalogs
  if (packageData.catalogs) {
    Object.entries(packageData.catalogs).forEach(([catalogName, catalogDeps]) => {
      catalogDependencies[catalogName] = { ...catalogDependencies[catalogName], ...catalogDeps }
    })
  }

  // Workspaces catalogs (Bun format)
  if (packageData.workspaces && !Array.isArray(packageData.workspaces)) {
    // Add default catalog from workspaces if it exists
    if (packageData.workspaces.catalog) {
      catalogDependencies.default = { ...catalogDependencies.default, ...packageData.workspaces.catalog }
    }
    // Add named catalogs from workspaces
    if (packageData.workspaces.catalogs) {
      Object.entries(packageData.workspaces.catalogs).forEach(([catalogName, catalogDeps]) => {
        catalogDependencies[catalogName] = { ...catalogDependencies[catalogName], ...catalogDeps }
      })
    }
  }

  return Object.keys(catalogDependencies).length > 0 ? catalogDependencies : null
}

/**
 * Gets all workspace packages information.
 *
 * @param options the application options, used to determine which packages to return.
 * @param defaultPackageFilename the default package filename
 * @returns a list of PackageInfo objects, one for each workspace file
 */
async function getWorkspacePackageInfos(
  options: Options,
  defaultPackageFilename: string,
  rootPackageFile: string,
  cwd: string,
): Promise<[PackageInfo[], string[]]> {
  // use silent, otherwise there will be a duplicate "Checking" message
  const { pkgData, pkgPath } = await findPackage({ ...options, packageFile: rootPackageFile, loglevel: 'silent' })
  const rootPkg: PackageFile = typeof pkgData === 'string' ? JSON.parse(pkgData) : pkgData

  const workspacesObject = rootPkg.workspaces || (await readPnpmWorkspaces(pkgPath || ''))
  const workspaces = Array.isArray(workspacesObject) ? workspacesObject : workspacesObject?.packages

  if (!workspaces) {
    programError(
      options,
      `workspaces property missing from package.json. --workspace${
        options.workspaces ? 's' : ''
      } only works when you specify a "workspaces" property in your package.json.`,
    )
  }

  // build a glob from the workspaces
  // FIXME: the following workspaces check is redundant
  const workspacePackageGlob: string[] = (workspaces || []).map(workspace =>
    path
      .join(cwd, workspace, 'package.json')
      // convert Windows path to *nix path for globby
      .replace(/\\/g, '/'),
  )

  // e.g. [packages/a/package.json, ...]
  const allWorkspacePackageFilepaths: string[] = glob.sync(workspacePackageGlob, globOptions)

  // Get the package names from the package files.
  // If a package does not have a name, use the folder name.
  // These will be used to filter out local workspace packages so they are not fetched from the registry.
  const allWorkspacePackageInfos: PackageInfo[] = await Promise.all(
    allWorkspacePackageFilepaths.map(async (filepath: string): Promise<PackageInfo> => {
      const info: PackageInfo = await loadPackageInfoFromFile(options, filepath)
      info.name = info.pkg.name || filepath.split('/').slice(-2)[0]
      return info
    }),
  )

  // Workspace package names
  // These will be used to filter out local workspace packages so they are not fetched from the registry.
  const allWorkspacePackageNames: string[] = allWorkspacePackageInfos.map(
    (packageInfo: PackageInfo): string => packageInfo.name || '',
  )

  const filterWorkspaces = options.workspaces !== true
  if (!filterWorkspaces) {
    // --workspaces
    return [allWorkspacePackageInfos, allWorkspacePackageNames]
  }

  // add workspace packages
  // --workspace
  const selectedWorkspacePackageInfos: PackageInfo[] = allWorkspacePackageInfos.filter((packageInfo: PackageInfo) =>
    options.workspace?.some((workspace: string) =>
      workspaces?.some(
        (workspacePattern: string) =>
          packageInfo.name === workspace ||
          packageInfo.filepath ===
            path.join(cwd, path.dirname(workspacePattern), workspace, defaultPackageFilename).replace(/\\/g, '/'),
      ),
    ),
  )
  return [selectedWorkspacePackageInfos, allWorkspacePackageNames]
}

/**
 * Gets catalog package info from pnpm-workspace.yaml or package.json.
 *
 * @param options the application options
 * @param pkgPath the package file path (already resolved)
 * @returns PackageInfo for catalog dependencies or null if no catalogs exist
 */
async function getCatalogPackageInfo(options: Options, pkgPath: string): Promise<PackageInfo | null> {
  if (!pkgPath) {
    return null
  }

  const catalogDependencies = await readCatalogDependencies(options, pkgPath)
  if (!catalogDependencies) {
    return null
  }

  // Flatten all catalog dependencies into a single object for backwards compatibility
  const flattenedCatalogDependencies: Index<VersionSpec> = {}
  Object.values(catalogDependencies).forEach(catalogDeps => {
    Object.assign(flattenedCatalogDependencies, catalogDeps)
  })

  // Create a synthetic package info for catalog dependencies
  const catalogPackageFile: PackageFile = {
    name: 'catalog-dependencies',
    version: '1.0.0',
    dependencies: flattenedCatalogDependencies,
  }

  // Determine the correct file path for catalogs. For pnpm, use pnpm-workspace.yaml.
  // For Bun catalogs in package.json, use a virtual path to avoid conflicts with root package.
  const catalogFilePath =
    options.packageManager === 'pnpm' ? path.join(path.dirname(pkgPath), 'pnpm-workspace.yaml') : `${pkgPath}#catalog`

  // Create synthetic file content that matches the synthetic PackageFile
  const syntheticFileContent = JSON.stringify(catalogPackageFile, null, 2)

  const catalogPackageInfo: PackageInfo = {
    filepath: catalogFilePath,
    pkg: catalogPackageFile,
    pkgFile: syntheticFileContent,
    name: 'catalogs',
  }

  return catalogPackageInfo
}

/**
 * Gets all local packages, including workspaces (depending on -w, -ws, and -root).
 *
 * @param options the application options, used to determine which packages to return.
 * @returns [PackageInfo[], string[], Index<Index<VersionSpec>> | null] an array of all package infos to be considered for updating, workspace names, and catalog dependencies if any
 */
async function getAllPackages(options: Options): Promise<[PackageInfo[], string[], Index<Index<VersionSpec>> | null]> {
  const defaultPackageFilename = options.packageFile || 'package.json'
  const cwd = options.cwd ? untildify(options.cwd) : './'
  const rootPackageFile = options.packageFile || (options.cwd ? path.join(cwd, 'package.json') : 'package.json')

  const useWorkspaces: boolean =
    options.workspaces === true || (options.workspace !== undefined && options.workspace.length !== 0)

  let packageInfos: PackageInfo[] = []

  // Find the package file with globby.
  // When in workspaces mode, only include the root project package file when --root is used.
  const getBasePackageFile: boolean = !useWorkspaces || options.root === true
  if (getBasePackageFile) {
    // we are either:
    // * NOT a workspace
    // * a workspace and have requested an upgrade of the workspace-root
    const globPattern = rootPackageFile.replace(/\\/g, '/')
    const rootPackagePaths = glob.sync(globPattern, globOptions)
    // realistically there should only be zero or one
    const rootPackages = await Promise.all(
      rootPackagePaths.map(
        async (packagePath: string): Promise<PackageInfo> => await loadPackageInfoFromFile(options, packagePath),
      ),
    )
    packageInfos = [...packageInfos, ...rootPackages]
  }

  // Read catalog dependencies (if any)
  const catalogDependencies = await readCatalogDependencies(options, rootPackageFile)

  if (!useWorkspaces) {
    return [packageInfos, [], catalogDependencies]
  }

  // Read catalog dependencies first so we can resolve references
  let catalogPackageInfo: PackageInfo | null = null

  if (options.workspaces) {
    const { pkgPath: workspacePkgPath } = await findPackage({
      ...options,
      packageFile: rootPackageFile,
      loglevel: 'silent',
    })
    if (workspacePkgPath) {
      catalogPackageInfo = await getCatalogPackageInfo(options, workspacePkgPath)
    }
  }

  // workspaces
  const [workspacePackageInfos, workspaceNames]: [PackageInfo[], string[]] = await getWorkspacePackageInfos(
    options,
    defaultPackageFilename,
    rootPackageFile,
    cwd,
  )

  // Don't resolve catalog references in workspace packages - leave them as "catalog:*"
  // Only the catalog definitions themselves should be updated
  packageInfos = [...packageInfos, ...workspacePackageInfos]

  // Add catalog package info for version checking (only if there are catalogs)
  if (catalogPackageInfo) {
    packageInfos = [...packageInfos, catalogPackageInfo]
  }

  return [packageInfos, workspaceNames, catalogDependencies]
}

export default getAllPackages
