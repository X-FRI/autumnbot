import { Command, CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { APIModelRepository } from "../../domain/repository/api-model.repository";
import { BadRequestException, Inject, NotFoundException } from "@nestjs/common";
import {
  AI_COMMINICATE_API,
  AI_COMMINICATE_REPOSITORY,
  API_MODEL_REPOSITORY,
} from "../../ai-model.constants";
import { AIComminicateApi } from "../../domain/api/ai-comminicate.api";
import { ApiProperty } from "@nestjs/swagger";
import { EventPublisher } from "@nestjs/cqrs";
import {
  AiComminicateLoadedEvent,
  FastTextCompletionCreatedEvent,
} from "../../domain/event";
import { IsArray, IsNotEmpty, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import {
  AiComminicate,
  AiComminicateMessage as AiComminicateMessageDomain,
} from "../../domain/model/ai-comminicate.model";
import { AiComminicateRepository } from "../../domain/repository/ai-comminicate.repository";
import { AiComminicateCreatedEvent } from "../../domain/event/ai-comminicate-created.event";
import { APIModel } from "../../domain/model/api-model.model";
import { LoggingService } from "@src/modules/infrastructure/logging/logging.service";

export class AiComminicateMessage {
  @ApiProperty({
    description: "The role",
    type: String,
  })
  @IsString()
  public readonly role: string;

  @ApiProperty({
    description: "The content",
    type: String,
  })
  @IsString()
  public readonly content: string;

  @ApiProperty({
    description: "The context id",
    type: String,
    nullable: true,
  })
  @IsString()
  public readonly contextId: string | null;
}

export class FastTextCompletionRequest {
  @ApiProperty({
    description: "The model id",
    type: String,
  })
  @IsString()
  public readonly modelId: string;

  @ApiProperty({
    description: "The messages",
    type: [AiComminicateMessage],
  })
  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AiComminicateMessage)
  public readonly messages: AiComminicateMessage[];
}

export class FastTextCompletionResponse {
  @ApiProperty({
    description: "The context id from the AI model",
    type: String,
  })
  @IsString()
  public readonly contextId: string;

  @ApiProperty({
    description: "The messages from the user",
    type: [AiComminicateMessage],
  })
  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AiComminicateMessage)
  public readonly messages: AiComminicateMessage[];
}

export class FastTextCompletionCommand extends Command<FastTextCompletionResponse> {
  constructor(public readonly body: FastTextCompletionRequest) {
    super();
  }
}

@CommandHandler(FastTextCompletionCommand)
export class FastTextCompletionCommandHandler
  implements ICommandHandler<FastTextCompletionCommand>
{
  constructor(
    @Inject(AI_COMMINICATE_API)
    private readonly aiComminicateApi: AIComminicateApi,
    @Inject(API_MODEL_REPOSITORY)
    private readonly apiModelRepository: APIModelRepository,
    @Inject(AI_COMMINICATE_REPOSITORY)
    private readonly aiComminicateRepository: AiComminicateRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly logger: LoggingService,
  ) {}

  private validateMessages(messages: AiComminicateMessage[]): void {
    if (messages.length === 0) {
      throw new BadRequestException("Messages are required");
    }

    if (new Set(messages.map((message) => message.contextId)).size !== 1) {
      throw new BadRequestException(
        "All messages must have the same contextId",
      );
    }
  }

  private async aiComminicateInitializer(apiModel: APIModel) {
    const aiComminicate = this.eventPublisher.mergeObjectContext(
      await this.aiComminicateRepository.save(
        AiComminicate.create({
          model: apiModel,
          messages: [],
        }),
      ),
    );

    aiComminicate.apply(new AiComminicateCreatedEvent(aiComminicate));
    return aiComminicate;
  }

  private async buildAiComminicate(
    contextId: string | null,
    apiModel: APIModel,
  ) {
    // If the contextId is null, we need to create a new aiComminicate
    if (contextId === null) return this.aiComminicateInitializer(apiModel);

    // If the contextId is not null, we need to load messages from repository
    const aiComminicate = this.eventPublisher.mergeObjectContext(
      await this.aiComminicateRepository.findById(contextId),
    );

    // If the aiComminicate has no messages, we need to create a new aiComminicate.
    // Theoretically, this situation cannot exist,
    // but the assessment is that it will not affect the normal operation of the system.
    if (aiComminicate.props.messages.length === 0) {
      this.logger.warn("AiComminicate has no messages, creating a new one", {
        contextId,
        apiModelId: apiModel.id,
      });
      return this.aiComminicateInitializer(apiModel);
    }

    aiComminicate.apply(new AiComminicateLoadedEvent(aiComminicate));
    return aiComminicate;
  }

  async execute(
    command: FastTextCompletionCommand,
  ): Promise<FastTextCompletionResponse> {
    const { modelId, messages } = command.body;
    this.validateMessages(messages);

    const apiModel = await this.apiModelRepository
      .findById(modelId)
      .then((apiModel) => {
        if (!apiModel) {
          throw new NotFoundException(
            `API model not found, modelId: ${modelId}`,
          );
        }

        return this.eventPublisher.mergeObjectContext(apiModel);
      });

    // The contextId is the same for all messages, so we can use the first one
    // and the contextId actually is the aiComminicate id
    const contextId = messages[0].contextId;
    const aiComminicate = await this.buildAiComminicate(contextId, apiModel);

    // Add the user message to the aiComminicate
    aiComminicate.addMessage(
      AiComminicateMessageDomain.create({
        role: "user",
        content: messages[0].content,
        contextId: aiComminicate.id,
        model: apiModel.props.model,
      }),
    );

    // Call the AI model and save context messageswith the response
    const aiComminicateWithResponse = this.eventPublisher.mergeObjectContext(
      await this.aiComminicateRepository.save(
        await this.aiComminicateApi.fastTextCompletion(apiModel, aiComminicate),
      ),
    );

    aiComminicateWithResponse.apply(
      new FastTextCompletionCreatedEvent(aiComminicateWithResponse),
    );

    return {
      contextId: aiComminicate.id,
      messages: aiComminicate.props.messages.map((message) => ({
        role: message.props.role,
        content: message.props.content,
        contextId: message.props.contextId,
      })),
    };
  }
}
