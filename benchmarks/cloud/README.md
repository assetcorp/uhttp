# Record a benchmark run on a named cloud machine

The figures in [`BENCHMARKS.md`](../../BENCHMARKS.md) describe only the machine on which the suite measured them, so when somebody records a run on a laptop, nobody else can repeat it on the same hardware. This toolkit rents a virtual machine from the cloud provider that you choose and starts the suite on it. Once the suite finishes, the toolkit copies the new run directory back into this repository, and it can delete the machine as well. Anybody can then rent the same machine type in the same location and repeat the measurement.

The toolkit has one shared core for every provider. Each provider has a small driver under `providers/`, which creates the machine, finds its address, and deletes it, while the files under `lib/` contain the steps that every provider shares: packaging the working tree, starting the suite, streaming its log, copying the results back, and printing the plan in a dry run.

## Pick a provider

Choose the cloud with the `PROVIDER` variable, which defaults to `gcp`. Each default has 8 vCPUs, so the suite can pin the server to CPU 1 and the 4 threads of h2load to CPUs 2 to 5, as [`benchmarks/README.md`](../README.md) describes. None of the defaults is a shared-core or burstable type, because when another customer can borrow a CPU, the speed of the server can change from one minute to the next.

| `PROVIDER` | Command-line tool | Default machine | Default location | Login | On-demand price |
| --- | --- | --- | --- | --- | --- |
| `gcp` | `gcloud` | `c3-standard-8`, 8 vCPUs | `us-central1-a` | managed by `gcloud` | about $0.40 an hour |
| `hetzner` | `hcloud` | `ccx33`, 8 dedicated vCPUs | `fsn1` | `root` | about $0.25 an hour |
| `digitalocean` | `doctl` | `g-8vcpu-32gb`, 8 dedicated vCPUs | `nyc3` | `root` | about $0.38 an hour |
| `aws` | `aws` | `m7i.2xlarge`, 8 vCPUs | `us-east-1` | `ubuntu` | about $0.40 an hour |

The prices are from the pages for [`c3-standard-8`](https://sparecores.com/server/gcp/c3-standard-8), [`ccx33`](https://sparecores.com/server/hcloud/ccx33), and [`m7i.2xlarge`](https://sparecores.com/server/aws/m7i.2xlarge) on Spare Cores and from the [DigitalOcean Droplet pricing page](https://www.digitalocean.com/pricing/droplets), as those pages listed them on 19 October 2026. Confirm the price with the provider before you start, because providers change their prices.

## Before you start

- Install the command-line tool of your provider and sign in with it: `gcloud auth login` with a project set, `hcloud context create` or an `HCLOUD_TOKEN`, `doctl auth init`, or `aws configure`.
- For `hetzner`, `digitalocean`, and `aws`, you need an SSH key pair. The toolkit uses `~/.ssh/id_ed25519` or `~/.ssh/id_rsa` unless you set `SSH_KEY=/path/to/key`, and it reads the public key from `<key>.pub`. On GCP, `gcloud` manages the keys for you.
- You need git and bash on your own machine, since the toolkit asks git which files to send.

## One command

Start the published profile on the default GCP machine from this directory:

```bash
./run-cloud.sh all
```

After you confirm that the provider can bill you, the toolkit creates the VM and sends your working tree to it, including the changes that you have not committed. It then installs Node 24, pnpm, uv, and the workspace on the VM. It also builds h2load 1.70.0 from the nghttp2 release, because Ubuntu 24.04 packages h2load 1.59.0, which is older than the 1.69.0 that the suite needs. The suite builds uhttp and measures every server, while the toolkit streams its log to your terminal. With the default settings, the suite applies load to 30 server processes for 240 seconds each, which comes to 2 hours of load. When the suite finishes, the toolkit copies the new run directory into `benchmarks/results/runs/`.

The toolkit leaves the VM up afterwards, so that you can look around on it, and it prints the command that deletes it. Add `--teardown` to delete the VM when `all` exits, and `--yes` to skip the billing confirmation:

```bash
PROVIDER=hetzner ./run-cloud.sh all --yes --teardown
```

## Test it before you trust it

With `--dry-run`, the toolkit prints its plan, with the commands that it would send to the provider and to the VM, and it creates nothing:

```bash
PROVIDER=aws ./run-cloud.sh all --dry-run
```

To check the whole path on a real VM with a short measurement, choose the smoke profile with two servers and one route, and delete the VM afterwards:

```bash
PROVIDER=hetzner BENCH_PROFILE=smoke BENCH_SERVERS=uhttp,uws BENCH_ROUTES=plain \
  ./run-cloud.sh all --yes --teardown
```

## One step at a time

`all` calls `up`, `sync`, `setup`, `run`, and `fetch` in that order, and you can call each of them on its own while you work, as in `PROVIDER=hetzner ./run-cloud.sh sync`:

| Command | What it does |
| --- | --- |
| `up` | Creates the VM |
| `sync` | Sends the working tree to the VM again after a change |
| `setup` | Installs Node 24, pnpm, and uv on the VM, and builds h2load |
| `run` | Starts the suite on the VM and streams its log |
| `logs` | Streams the log again after the connection drops |
| `fetch` | Copies the new run directories back into this repository |
| `ssh` | Opens a shell on the VM |
| `status` | Shows the state of the VM |
| `down` | Deletes the VM |

`run` starts the suite under `nohup` on the VM, so the suite carries on when your laptop sleeps or the connection drops. While the suite works, the toolkit streams its log and reconnects after a dropped connection, until 20 reconnections in a row add no new line to the log. Press Ctrl-C to stop the stream, which leaves the suite going, and call `logs` to stream the log again from its first line. When you stop the stream inside `all`, the toolkit keeps the VM even with `--teardown`, and it reminds you to call `logs`, then `fetch`, and then `down`.

`sync`, `run`, and `fetch` each refuse to start while the suite is still going. A new working tree or a second suite on the VM will disturb the measurement, and `fetch` can copy a run directory only once the suite has written all of it.

## Configuration

Every default comes from an environment variable:

| Variable | Default | What it sets |
| --- | --- | --- |
| `PROVIDER` | `gcp` | `gcp`, `hetzner`, `digitalocean`, or `aws` |
| `VM_NAME` | `uhttp-bench` | The name of the VM, in lowercase letters, digits, and hyphens |
| `MACHINE_TYPE` | per provider | The machine type |
| `DISK_SIZE` | `20` | The size of the boot disk in GB on GCP and AWS, since Hetzner and DigitalOcean include the disk with the machine type |
| `VM_MAX_HOURS` | `8` | The hours after which GCP or AWS deletes the VM, where `0` turns the deadline off |
| `SSH_KEY` | `~/.ssh/id_ed25519` | The private key for Hetzner, DigitalOcean, and AWS |
| `BENCH_PROFILE` | `published` | `published` for `benchmarks/results/runs/`, or `smoke` for `benchmarks/results/.smoke/runs/`, which git ignores |
| `BENCH_MACHINE_LABEL` | the provider, the machine type, and the location, as in `GCP c3-standard-8, us-central1-a` | The name of the machine that the suite records in `machine.json` and that `BENCHMARKS.md` prints, in up to 120 letters, digits, spaces, and the characters `, . / ( ) _ -` |
| `BENCH_SERVERS`, `BENCH_ROUTES`, `BENCH_HEADERS` | every one | The servers, routes, and sets of headers to measure, in the smoke profile alone |
| `BENCH_CONNECTIONS`, `BENCH_DURATION`, `BENCH_WARM_UP`, `BENCH_THREADS` | the defaults of the profile | The connection counts, the seconds of load at each count, the seconds of warm-up, and the threads of h2load |

The toolkit passes each `BENCH_` variable in the last two rows of the table to the suite as the option of the same name, such as `BENCH_SERVERS` as `--servers` and `BENCH_WARM_UP` as `--warm-up`, and [`benchmarks/README.md`](../README.md) describes every option. The toolkit accepts letters, digits, and commas alone in those variables. It also refuses `BENCH_SERVERS`, `BENCH_ROUTES`, and `BENCH_HEADERS` in the published profile before it creates anything, because the suite measures every server, route, and set of headers in that profile.

Each driver also reads its own variables: `GCP_PROJECT`, `GCP_ZONE`, `MIN_CPU_PLATFORM`, and `USE_IAP` for GCP, `HCLOUD_LOCATION` for Hetzner, `DO_REGION` for DigitalOcean, and `AWS_REGION`, `AWS_SUBNET`, `AWS_AMI`, and `AWS_SG_NAME` for AWS.

## The deadline on the VM

The provider bills for a VM that somebody forgets, so on GCP and AWS the toolkit gives every new VM a deadline of `VM_MAX_HOURS` hours, 8 by default. GCP deletes the VM at that time, because the toolkit creates it with a termination time and the `DELETE` action. On AWS, a user data script schedules a shutdown at the first boot of the instance, and the toolkit creates the instance so that a shutdown terminates it. A restart of the instance cancels that shutdown, so check the instance with `status` after a restart.

Before `run` starts the suite on GCP, the toolkit reads the deadline from a label on the VM. It refuses to start when fewer than 3 hours remain for the published profile, or fewer than 1 hour for the smoke profile. The toolkit sets no deadline on Hetzner and DigitalOcean, so delete those VMs with `down` yourself.

## What `sync` sends

`sync` asks git for every file that it tracks and every file that it leaves untracked but not ignored, so `node_modules`, `dist`, the smoke runs, and the untracked runs under `benchmarks/results/runs/` stay on your machine. It also sends `.git`, which the suite reads to record the commit of uhttp in `results.json`, but it leaves out `.git/config`, so that a token in the URL of a remote stays on your machine. Check `git status` before you sync, because `sync` sends every untracked file that git does not ignore.

On the VM, `sync` unpacks the new tree beside the old one and moves every run directory that the new tree lacks from the old tree into the new one, so `sync` never deletes a run that you have not fetched yet.

## What `fetch` copies

`fetch` copies the run directories that the suite created on the VM into the directory of the profile that `BENCH_PROFILE` names, so set the same profile when you call `fetch` on its own. In the published profile, it skips every run directory that git tracks on the VM, because somebody has already committed those runs to the repository. It never replaces a run directory that exists in your repository, and it skips any directory whose name differs from the UTC time that the suite gives each run, such as `20261019T004707Z`. It also skips a directory that lacks `results.json` or `machine.json`. The toolkit copies each run into a hidden directory first and moves it into place once the copy is complete, so the generator never finds a half-written run after an interrupted copy.

When the suite records a failed measurement, `fetch` still copies the run and tells you about the failure, so that you can read it in `results.json`. Delete that directory before you regenerate the page, because the generator reads the newest run.

## Publish a run

The suite regenerates the page on the VM, and the toolkit leaves that copy there, so regenerate `BENCHMARKS.md` and both READMEs on your own machine after `fetch`:

```bash
cd benchmarks/writeup
uv run --frozen python generate.py
```

Then commit the new run directory together with the page and both READMEs. In the `machine.json` of the run, the suite records the label from `BENCH_MACHINE_LABEL`, the CPU model, the memory, the operating system, and the versions of Node.js and h2load, so that a reader of the page can rent the same machine.

## What each provider sets up

- On **GCP**, `gcloud` makes the connection and manages its keys. The toolkit creates the VM with no service account and no access scopes, so no program on the VM can get Google Cloud credentials from the metadata server. With `USE_IAP=1`, `gcloud` sends SSH through Identity-Aware Proxy, although the VM still has a public address, since apt, pnpm, and uv need it to download packages.
- On **Hetzner** and **DigitalOcean**, the toolkit registers your public key when the provider lacks it, creates the server, and connects as `root` to its public address.
- On **AWS**, the toolkit imports your key pair and creates a security group in the default VPC when the group is missing. It then adds the current public IPv4 address of your machine to the SSH rules of that group. It finds the newest Ubuntu 24.04 AMI from Canonical, requires IMDSv2 on the instance, tags the instance with its name, and connects as `ubuntu`. Set `AWS_SUBNET` and `AWS_SG_NAME` when your region has no default VPC.

## Security

Treat every VM as a machine that you will throw away, and delete it once you have fetched its run. On Hetzner and DigitalOcean, the toolkit adds no firewall, so the VM accepts SSH connections from any address. On AWS, the security group allows SSH from each address that the toolkit adds to it, and the toolkit removes none of them, so delete an old address in the AWS console once you stop using it. On GCP, the firewall rules of your project set which addresses can reach port 22.

The toolkit accepts the host key that the SSH server on a new VM presents and stores none, because the provider gives each VM a fresh address and the VM generates a fresh host key. That choice means the toolkit cannot detect an impostor on any connection to a VM. The toolkit prints no credentials, since each command-line tool reads its credentials from its own configuration. The toolkit also sends no cloud credentials to the VM.
