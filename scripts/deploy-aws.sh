#!/usr/bin/env bash
# Deploys Afterhours to AWS: builds the image, pushes it to ECR, and deploys
# infra/aws.yaml (App Runner + DynamoDB + Secrets Manager + EventBridge).
#
#   AWS_REGION=us-east-1 ./scripts/deploy-aws.sh
#
# Needs: AWS CLI v2 with credentials, Docker. Optional env: STACK (default
# afterhours), PUBLIC_URL (a custom domain; otherwise the App Runner URL is
# used), ALEXA_CLIENT_ID, ALEXA_REDIRECT_URIS, BEDROCK_MODEL.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-afterhours}"
REPO="${ECR_REPO:-afterhours}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
IMAGE="$REGISTRY/$REPO:$TAG"

echo "→ ECR repository $REPO"
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --region "$REGION" --repository-name "$REPO" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

echo "→ Building and pushing $IMAGE"
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE" >/dev/null

deploy() {
  aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
    --template-file infra/aws.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
    --parameter-overrides "ImageUri=$IMAGE" "PublicUrl=$1" \
      "AlexaClientId=${ALEXA_CLIENT_ID:-}" "AlexaRedirectUris=${ALEXA_REDIRECT_URIS:-}" \
      "BedrockModel=${BEDROCK_MODEL:-anthropic.claude-opus-5-5}"
}
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

echo "→ Deploying stack $STACK"
deploy "${PUBLIC_URL:-}"
URL="${PUBLIC_URL:-https://$(output ServiceUrl)}"

# First deploy can't know its own URL; the second pass sets it (the OAuth
# issuer and MCP resource URI) and turns on the EventBridge tape schedule.
if [ -z "${PUBLIC_URL:-}" ]; then
  echo "→ Setting PUBLIC_URL=$URL"
  deploy "$URL"
fi

echo "→ Health"
curl -sf "$URL/health" | head -c 400; echo
echo
echo "MCP endpoint:  $(output McpEndpoint)"
echo "Simulator:     $URL/sim/"
echo "Conformance:   npm run conformance -- $URL"
