/**
 * Bringing your own kernel / bootloader.
 *
 * rsdk has no "replace the kernel" switch. What it has is:
 *
 *   --debs <dir>        publish the .deb files in <dir> as a local apt
 *                       repository with pin 1999, so any package name they
 *                       provide wins over the repositories, and
 *   -k / -f <name>      change which kernel / bootloader package is requested
 *                       at all (`linux-image-<name>`, `<boot>-<name>`).
 *
 * So there are two ways to do it, and which one applies depends only on the
 * package names inside the .deb files:
 *
 *   same names      just supply the .debs - pin 1999 makes them win
 *   renamed         supply the .debs and set -k / -f to the new names
 *
 * Either way the build asks for the four packages below, and that is what the
 * preflight and the UI check against.
 */
import type { Product } from './catalog.ts'
import type { Profile } from './schema.ts'

/** 'u-boot' for most boards, 'edk2' for the ones that boot via UEFI */
export function bootloaderPrefix(product: Product | undefined): string {
  return product?.firmware_type ?? 'u-boot'
}

export function requiredKernelPackages(profile: Profile, product: Product | undefined): string[] {
  const name = profile.target.product
  const kernel = profile.packages.kernelOverride || name
  const boot = bootloaderPrefix(product)
  const firmware = profile.packages.firmwareOverride || name
  return [
    ...new Set([
      `task-${name}`,
      `${boot}-${name}`,
      `linux-image-${kernel}`,
      `linux-headers-${kernel}`,
      `${boot}-${firmware}`,
    ]),
  ]
}
