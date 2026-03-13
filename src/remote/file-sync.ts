import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type { RemoteMachine } from "./types.js";
import { shellQuote } from "../ui/format.js";

const execAsync = promisify(execCb);

/**
 * File sync via rsync/SCP over SSH.
 */
export class FileSync {
  private machines = new Map<string, RemoteMachine>();

  addMachine(machine: RemoteMachine): void {
    this.machines.set(machine.id, machine);
  }

  /**
   * Upload local files to remote machine using rsync.
   */
  async upload(
    machineId: string,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    const machine = this.getMachine(machineId);
    const sshArgs = this.buildSshArgs(machine);
    const remote = `${machine.username}@${machine.host}:${remotePath}`;

    await execAsync(
      `rsync -avz -e "ssh ${sshArgs}" ${shellQuote(localPath)} ${shellQuote(remote)}`,
    );
  }

  /**
   * Download remote files to local machine using rsync.
   */
  async download(
    machineId: string,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const machine = this.getMachine(machineId);
    const sshArgs = this.buildSshArgs(machine);
    const remote = `${machine.username}@${machine.host}:${remotePath}`;

    await execAsync(
      `rsync -avz -e "ssh ${sshArgs}" ${shellQuote(remote)} ${shellQuote(localPath)}`,
    );
  }

  private getMachine(id: string): RemoteMachine {
    const machine = this.machines.get(id);
    if (!machine) throw new Error(`Unknown machine: ${id}`);
    return machine;
  }

  private buildSshArgs(machine: RemoteMachine): string {
    const args: string[] = [`-p ${machine.port}`];
    if (machine.authMethod === "key" && machine.keyPath) {
      args.push(`-i ${shellQuote(machine.keyPath)}`);
    }
    return args.join(" ");
  }
}
