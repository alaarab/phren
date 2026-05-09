import { getPhrenPath } from "../shared.js";

function printProfileUsage() {
  console.log("Usage:");
  console.log("  phren profile list                  List all available profiles");
  console.log("  phren profile switch <name>         Switch to an active profile");
}

export async function handleProfileNamespace(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printProfileUsage();
    return;
  }

  const phrenPath = getPhrenPath();

  if (subcommand === "list") {
    const { listProfiles, listMachines } = await import("../profile-store.js");
    const result = listProfiles(phrenPath);
    if (!result.ok) {
      console.error(`Failed to list profiles: ${result.error}`);
      process.exit(1);
    }

    const profiles = result.data || [];
    if (profiles.length === 0) {
      console.log("No profiles available.");
      return;
    }

    const machinesResult = listMachines(phrenPath);
    const machines = machinesResult.ok ? machinesResult.data : {};
    const { getMachineName } = await import("../machine-identity.js");
    const currentMachine = getMachineName();
    const activeProfile = machines[currentMachine];

    console.log(`${profiles.length} profile(s):\n`);
    for (const profile of profiles) {
      const isCurrent = profile.name === activeProfile ? " (current)" : "";
      const projectCount = profile.projects?.length ?? 0;
      console.log(`  ${profile.name}${isCurrent}`);
      console.log(`    projects: ${projectCount}`);
      console.log();
    }
    return;
  }

  if (subcommand === "switch") {
    const profileName = args[1];
    if (!profileName) {
      console.error("Usage: phren profile switch <name>");
      process.exit(1);
    }

    const { setMachineProfile, getDefaultMachineAlias, listProfiles } = await import("../profile-store.js");

    const listResult = listProfiles(phrenPath);
    if (!listResult.ok) {
      console.error(`Failed to list profiles: ${listResult.error}`);
      process.exit(1);
    }
    const profiles = listResult.data || [];
    if (!profiles.some((p: { name: string }) => p.name === profileName)) {
      console.error(`Profile not found: "${profileName}"`);
      console.log("Available profiles:");
      for (const p of profiles) {
        console.log(`  - ${p.name}`);
      }
      process.exit(1);
    }

    const machineAlias = getDefaultMachineAlias();
    const result = setMachineProfile(phrenPath, machineAlias, profileName);
    if (!result.ok) {
      console.error(`Failed to switch profile: ${result.error}`);
      process.exit(1);
    }

    console.log(`Switched to profile: ${profileName} (machine: ${machineAlias})`);
    return;
  }

  console.error(`Unknown profile subcommand: ${subcommand}`);
  printProfileUsage();
  process.exit(1);
}
