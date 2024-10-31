
import { Request } from "express";
import { config } from "../../../../config";
import { BadRequestError } from "../../../../shared/errors";

type ModerationCategory = keyof typeof config.moderationThresholds;

interface ModerationResponse {
  results: [{
    category_scores: {
      [K in ModerationCategory]: number;
    };
  }];
}

export const checkModeration = async (req: Request, prompt: string) => {
  // Only proceed if moderation is enabled and key exists
  if (!config.allowOpenAIModeration || !config.openaiModerationKey) return;

  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiModerationKey}`
    },
    body: JSON.stringify({
      model: config.openaiModerationModel,
      input: prompt
    })
  });

  if (!response.ok) {
    req.log.error(
      {
        status: response.status,
        statusText: response.statusText,
        key: config.openaiModerationKey?.slice(-4)
      },
      "Invalid or revoked OpenAI moderation key"
    );
    return;
  }

  if (response.ok) {
    const data = await response.json() as ModerationResponse;
    const result = data.results[0];

    const violations = Object.entries(result.category_scores)
      .filter((entry): entry is [ModerationCategory, number] => {
        const category = entry[0];
        const score = entry[1];
        return category in config.moderationThresholds &&
               score > config.moderationThresholds[category as ModerationCategory];
      })
      .map(([category]) => category);

    if (violations.length > 0) {
      const ip = req.ip;
      req.log.warn(
        {
          ip,
          violations,
          categoryScores: result.category_scores,
        },
        "Content flagged by OpenAI moderation"
      );

      throw new BadRequestError(`Content violates /AICG/ guidelines. Flagged categories: ${violations.join(", ")}`);
    }
  }
};
