import * as semver from 'semver'
import { Index } from '../types/IndexType'
import { Options } from '../types/Options'
import { PackageFile } from '../types/PackageFile'
import { VersionSpec } from '../types/VersionSpec'
import filterAndReject from './filterAndReject'
import filterObject from './filterObject'
import { keyValueBy } from './keyValueBy'
import programError from './programError'
import resolveDepSections from './resolveDepSections'

/** Returns true if spec1 is greater than spec2, ignoring invalid version ranges. */
const isGreaterThanSafe = (spec1: VersionSpec, spec2: VersionSpec) =>
  // not a valid range to compare (e.g. github url)
  semver.validRange(spec1) &&
  semver.validRange(spec2) &&
  // otherwise return true if spec2 is smaller than spec1
  semver.gt(semver.minVersion(spec1)!, semver.minVersion(spec2)!)

/** Parses the packageManager field into a { [name]: version } pair. */
const parsePackageManager = (pkgData: PackageFile) => {
  if (!pkgData.packageManager) return {}
  const [name, version] = pkgData.packageManager.split('@')
  return { [name]: version }
}
/**
 * Get the current dependencies from the package file.
 *
 * @param [pkgData={}] Object with dependencies, devDependencies, peerDependencies, and/or optionalDependencies properties.
 * @param [options={}]
 * @param options.dep
 * @param options.filter
 * @param options.reject
 * @returns Promised {packageName: version} collection
 */
function getCurrentDependencies(pkgData: PackageFile = {}, options: Options = {}) {
  const depSections = resolveDepSections(options.dep)

  // get all dependencies from the selected sections
  // if a dependency appears in more than one section, take the lowest version number
  const allDependencies = depSections.reduce((accum, depSection) => {
    return {
      ...accum,
      ...(depSection === 'packageManager'
        ? parsePackageManager(pkgData)
        : filterObject(
            (pkgData[depSection] as Index<string>) || {},
            (dep, spec) => !isGreaterThanSafe(spec, accum[dep]),
          )),
    }
  }, {} as Index<VersionSpec>)

  // filter & reject dependencies and versions
  const workspacePackageMap = keyValueBy(options.workspacePackages || [])
  let filteredDependencies: Index<VersionSpec> = {}
  try {
    filteredDependencies = filterObject(
      // catalog dependencies are handled separately
      filterObject(allDependencies, (name, version) => !workspacePackageMap[name] && !version.startsWith('catalog:')),
      filterAndReject(
        options.filter || null,
        options.reject || null,
        options.filterVersion || null,
        options.rejectVersion || null,
      ),
    )
  } catch (err: any) {
    programError(options, 'Invalid filter: ' + err.message || err)
  }

  return filteredDependencies
}

/**
 * Get the catalog dependencies from the package file (dependencies that reference catalogs).
 *
 * @param [pkgData={}] Object with dependencies, devDependencies, peerDependencies, and/or optionalDependencies properties.
 * @param [options={}]
 * @returns `{packageName: catalogReference}` collection
 */
export function getCatalogDependencies(pkgData: PackageFile = {}, options: Options = {}): Index<string> {
  const depSections = resolveDepSections(options.dep)

  // get all dependencies from the selected sections that start with "catalog:"
  const allDependencies = depSections.reduce((accum, depSection) => {
    const sectionDependencies = (pkgData[depSection] as Index<string>) || {}
    const catalogDependencies = filterObject(sectionDependencies, (name, version) => version.startsWith('catalog:'))
    return {
      ...accum,
      ...catalogDependencies,
    }
  }, {} as Index<string>)

  // filter & reject dependencies and versions
  const workspacePackageMap = keyValueBy(options.workspacePackages || [])
  let filteredDependencies: Index<string> = {}
  try {
    filteredDependencies = filterObject(
      filterObject(allDependencies, name => !workspacePackageMap[name]),
      filterAndReject(
        options.filter || null,
        options.reject || null,
        options.filterVersion || null,
        options.rejectVersion || null,
      ),
    )
  } catch (err: any) {
    programError(options, 'Invalid filter: ' + err.message || err)
  }

  return filteredDependencies
}

export default getCurrentDependencies
