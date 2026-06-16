root_path=$(cd `dirname $0` && cd .. && pwd)
cd "$root_path"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ipfs-gateway-use-subdomains)
      export IPFS_GATEWAY_USE_SUBDOMAINS=true
      shift
      ;;
    --shutdown-key)
      export SHUTDOWN_KEY="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

docker compose up --build -d
docker logs --follow pubsub-provider
