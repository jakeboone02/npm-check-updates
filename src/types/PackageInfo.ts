import { PackageFile } from './PackageFile'

/** Describes package data plus its filepath */
export interface PackageInfo {
  name?: string
  pkg: PackageFile
  pkgFile: string // the raw file string
  filepath: string
}
