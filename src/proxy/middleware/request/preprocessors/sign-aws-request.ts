import express, { Request } from "express";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import {
  AnthropicV1TextSchema,
  AnthropicV1MessagesSchema,
} from "../../../../shared/api-schemas";
import { keyPool } from "../../../../shared/key-management";
import { RequestPreprocessor } from "../index";
import {
  AWSMistralV1ChatCompletionsSchema,
  AWSMistralV1TextCompletionsSchema,
} from "../../../../shared/api-schemas/mistral-ai";

const AMZ_HOST =
  process.env.AMZ_HOST || "bedrock-runtime.%REGION%.amazonaws.com";

/**
 * Signs an outgoing AWS request with the appropriate headers modifies the
 * request object in place to fix the path.
 * This happens AFTER request transformation.
 */
export const signAwsRequest: RequestPreprocessor = async (req) => {
  const { model, stream } = req.body;
  req.key = keyPool.get(model, "aws");

  req.isStreaming = stream === true || stream === "true";

  // same as addAnthropicPreamble for non-AWS requests, but has to happen here
  if (req.outboundApi === "anthropic-text") {
    let preamble = req.body.prompt.startsWith("\n\nHuman:") ? "" : "\n\nHuman:";
    req.body.prompt = preamble + req.body.prompt;
  }

  const credential = getCredentialParts(req);
  const host = AMZ_HOST.replace("%REGION%", credential.region);

  // AWS only uses 2023-06-01 and does not actually check this header, but we
  // set it so that the stream adapter always selects the correct transformer.
  req.headers["anthropic-version"] = "2023-06-01";

  // Uses the AWS SDK to sign a request, then modifies our HPM proxy request
  // with the headers generated by the SDK.
  const newRequest = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: `/model/${model}/invoke${stream ? "-with-response-stream" : ""}`,
    headers: {
      ["Host"]: host,
      ["content-type"]: "application/json",
    },
    body: JSON.stringify(applyAwsStrictValidation(req)),
  });

  if (stream) {
    newRequest.headers["x-amzn-bedrock-accept"] = "application/json";
  } else {
    newRequest.headers["accept"] = "*/*";
  }

  const { key, body, inboundApi, outboundApi } = req;
  req.log.info(
    { key: key.hash, model: body.model, inboundApi, outboundApi },
    "Assigned AWS credentials to request"
  );

  req.signedRequest = await sign(newRequest, getCredentialParts(req));
};

type Credential = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

function getCredentialParts(req: express.Request): Credential {
  const [accessKeyId, secretAccessKey, region] = req.key!.key.split(":");

  if (!accessKeyId || !secretAccessKey || !region) {
    req.log.error(
      { key: req.key!.hash },
      "AWS_CREDENTIALS isn't correctly formatted; refer to the docs"
    );
    throw new Error("The key assigned to this request is invalid.");
  }

  return { accessKeyId, secretAccessKey, region };
}

async function sign(request: HttpRequest, credential: Credential) {
  const { accessKeyId, secretAccessKey, region } = credential;

  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });

  return signer.sign(request);
}

function applyAwsStrictValidation(req: Request): unknown {
  // AWS uses vendor API formats but imposes additional (more strict) validation
  // rules, namely that extraneous parameters are not allowed. We will validate
  // using the vendor's zod schema but apply `.strip` to ensure that any
  // extraneous parameters are removed.
  let strippedParams: Record<string, unknown> = {};
  switch (req.outboundApi) {
    case "anthropic-text":
      strippedParams = AnthropicV1TextSchema.pick({
        prompt: true,
        max_tokens_to_sample: true,
        stop_sequences: true,
        temperature: true,
        top_k: true,
        top_p: true,
      })
        .strip()
        .parse(req.body);
      break;
    case "anthropic-chat":
      strippedParams = AnthropicV1MessagesSchema.pick({
        messages: true,
        system: true,
        max_tokens: true,
        stop_sequences: true,
        temperature: true,
        top_k: true,
        top_p: true,
      })
        .strip()
        .parse(req.body);
      strippedParams.anthropic_version = "bedrock-2023-05-31";
      break;
    case "mistral-ai":
      strippedParams = AWSMistralV1ChatCompletionsSchema.parse(req.body);
      break;
    case "mistral-text":
      strippedParams = AWSMistralV1TextCompletionsSchema.parse(req.body);
      break;
    default:
      throw new Error("Unexpected outbound API for AWS.");
  }
  return strippedParams;
}
