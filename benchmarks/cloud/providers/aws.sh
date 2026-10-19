#!/usr/bin/env bash

. "$CLOUD_DIR/lib/raw-ssh.sh"

AWS_DEFAULT_MACHINE_TYPE="m7i.2xlarge"
AWS_DEFAULT_REGION_NAME="us-east-1"
CANONICAL_OWNER="099720109477"
PUBLIC_IP_LOOKUP_URL="https://checkip.amazonaws.com"
PUBLIC_IP_LOOKUP_TIMEOUT_SECONDS=10

prov_init() {
  require_cmd aws
  AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$AWS_DEFAULT_REGION_NAME}}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
  [ "$DRY_RUN" = "1" ] || aws sts get-caller-identity >/dev/null 2>&1 \
    || die "aws is not authenticated; run 'aws configure'"
  MACHINE_TYPE="${MACHINE_TYPE:-$AWS_DEFAULT_MACHINE_TYPE}"
  MACHINE_LABEL="${MACHINE_LABEL:-AWS $MACHINE_TYPE, $AWS_REGION}"
  SSH_USER="${SSH_USER:-ubuntu}"
  SG_NAME="${AWS_SG_NAME:-uhttp-bench-sg}"
  resolve_ssh_key
}

prov_hourly() {
  if [ "$MACHINE_TYPE" = "$AWS_DEFAULT_MACHINE_TYPE" ] && [ "$AWS_REGION" = "$AWS_DEFAULT_REGION_NAME" ]; then
    echo "about \$0.40 an hour"
  else
    echo "price on the Amazon EC2 pricing page"
  fi
}

aws_instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$VM_NAME" "Name=instance-state-name,Values=pending,running" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null \
    | tr '\t' '\n' | awk 'NF { print; exit }'
}

prov_exists() {
  [ -n "$(aws_instance_id)" ]
}

prov_ip() {
  local id
  id="$(aws_instance_id)"
  [ -n "$id" ] || return 1
  aws ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null
}

aws_public_ip_of_this_machine() {
  local address
  address="$(curl -fsS --max-time "$PUBLIC_IP_LOOKUP_TIMEOUT_SECONDS" "$PUBLIC_IP_LOOKUP_URL" 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$address" =~ $SERVER_IP_PATTERN ]] || return 1
  printf '%s' "$address"
}

aws_allow_ssh_from_here() {
  local group="$1" address allowed
  address="$(aws_public_ip_of_this_machine)" \
    || die "cannot find the public IPv4 address of this machine through $PUBLIC_IP_LOOKUP_URL"
  allowed="$(aws ec2 describe-security-groups --group-ids "$group" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`22\`].IpRanges[].CidrIp" --output text 2>/dev/null)" || allowed=""
  case " $(printf '%s' "$allowed" | tr '\t\n' '  ') " in
    *" $address/32 "*) return 0 ;;
  esac
  log "allow SSH into $SG_NAME from $address alone"
  aws ec2 authorize-security-group-ingress --group-id "$group" \
    --protocol tcp --port 22 --cidr "$address/32" >/dev/null
}

aws_security_group() {
  local group vpc
  group="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)" || group=""
  if [ -z "$group" ] || [ "$group" = "None" ]; then
    vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
      --query 'Vpcs[0].VpcId' --output text 2>/dev/null)" || vpc=""
    [ -n "$vpc" ] && [ "$vpc" != "None" ] || die "no default VPC in $AWS_REGION; set AWS_SUBNET and AWS_SG_NAME"
    group="$(aws ec2 create-security-group --group-name "$SG_NAME" \
      --description "uhttp benchmark SSH" --vpc-id "$vpc" --query 'GroupId' --output text)"
  fi
  [ -n "$group" ] && [ "$group" != "None" ] || die "cannot create or find the security group $SG_NAME"
  aws_allow_ssh_from_here "$group" >&2
  printf '%s' "$group"
}

aws_latest_ami() {
  aws ec2 describe-images --owners "$CANONICAL_OWNER" \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
    "Name=state,Values=available" \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null
}

prov_create() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would import the key pair '$SSH_KEY_NAME', ensure the security group '$SG_NAME' allows SSH from your IPv4 address alone, find the newest Ubuntu 24.04 AMI, and then:"
    local -a planned=(
      --image-id "<ami>" --instance-type "$MACHINE_TYPE"
      --key-name "$SSH_KEY_NAME" --security-group-ids "<security-group>"
      --block-device-mappings "gp3 ${DISK_SIZE}GB root, deleted on termination"
      --metadata-options "HttpTokens=required"
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$VM_NAME}]"
    )
    if [ "$VM_MAX_HOURS" != "0" ]; then
      planned+=(--instance-initiated-shutdown-behavior terminate --user-data "<shutdown ${VM_MAX_HOURS}h after first boot>")
    fi
    _run aws ec2 run-instances "${planned[@]}"
    return 0
  fi
  aws ec2 describe-key-pairs --key-names "$SSH_KEY_NAME" >/dev/null 2>&1 \
    || _run aws ec2 import-key-pair --key-name "$SSH_KEY_NAME" \
      --public-key-material "fileb://$SSH_PUBKEY" >/dev/null
  local group ami mapping
  group="$(aws_security_group)"
  ami="${AWS_AMI:-$(aws_latest_ami)}"
  [ -n "$ami" ] && [ "$ami" != "None" ] || die "cannot find an Ubuntu 24.04 AMI in $AWS_REGION"
  mapping="[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${DISK_SIZE},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]"
  local -a flags=(
    --image-id "$ami" --instance-type "$MACHINE_TYPE"
    --key-name "$SSH_KEY_NAME" --security-group-ids "$group"
    --block-device-mappings "$mapping"
    --metadata-options "HttpTokens=required"
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$VM_NAME}]"
  )
  if [ "$VM_MAX_HOURS" != "0" ]; then
    flags+=(--instance-initiated-shutdown-behavior terminate)
    flags+=(--user-data "$(printf '#!/bin/sh\nshutdown -h +%s\n' $((VM_MAX_HOURS * 60)))")
  fi
  if [ -n "${AWS_SUBNET:-}" ]; then
    flags+=(--subnet-id "$AWS_SUBNET")
  fi
  _run aws ec2 run-instances "${flags[@]}" --query 'Instances[0].InstanceId' --output text
  log "wait for the instance to start"
  _run aws ec2 wait instance-running \
    --filters "Name=tag:Name,Values=$VM_NAME" "Name=instance-state-name,Values=pending,running"
}

prov_lifetime_note() {
  if [ "$VM_MAX_HOURS" = "0" ]; then
    log "the self-delete backstop is off (VM_MAX_HOURS=0), so $VM_NAME bills until 'down'"
    return 0
  fi
  log "$VM_NAME shuts down and terminates about ${VM_MAX_HOURS}h after its first boot; a restart cancels that timer, so confirm with 'status'"
}

prov_delete() {
  if [ "$DRY_RUN" = "1" ]; then
    _run aws ec2 terminate-instances --instance-ids "<id of $VM_NAME>"
    return 0
  fi
  local id
  id="$(aws_instance_id)"
  [ -n "$id" ] || { log "$VM_NAME not found"; return 0; }
  _run aws ec2 terminate-instances --instance-ids "$id" \
    --query 'TerminatingInstances[0].CurrentState.Name' --output text
}

prov_status() {
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$VM_NAME" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress]' \
    --output text 2>/dev/null || log "$VM_NAME not found"
}
